const { setImmediate } = require("timers");
const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { isResponseCancellation } = require("../src/core/response-cancellation");
const { InvalidCredentialBackoff } = require("../src/core/invalid-credential-backoff");
const { clearStagedRowsInBatches } = require("../src/core/file-tree");
const { redactSecrets } = require("../src/core/redact-secrets");

describe("production log failure handling", () => {
  it("suppresses cancellation only when the downstream is destroyed", () => {
    for (const error of [new Error("response_cancelled"),
      Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" }),
      { cause: new Error("response_cancelled") }]) {
      expect(isResponseCancellation(error, { destroyed: true, req: { aborted: true } })).to.equal(true);
      expect(isResponseCancellation(error, { destroyed: false })).to.equal(false);
    }
    expect(isResponseCancellation({ code: "ECONNRESET" }, { destroyed: true })).to.equal(false);
    expect(isResponseCancellation({ code: "ERR_STREAM_PREMATURE_CLOSE" }, { destroyed: true })).to.equal(false);
    const cycle = {}; cycle.cause = cycle;
    expect(isResponseCancellation(cycle, { destroyed: true })).to.equal(false);
  });
  it("keeps credential timing while redacting authorization headers", () => {
    expect(redactSecrets({ stages: { credential_resolution: 12 }, headers: { authorization: "secret" } }))
      .to.deep.equal({ stages: { credential_resolution: 12 }, headers: { authorization: "[REDACTED]" } });
  });
  it("backs off exact invalid credentials but not rotated tokens or transient errors", async () => {
    let now = 0;
    const gate = new InvalidCredentialBackoff(() => now);
    let calls = 0;
    const request = async () => { calls++; throw Object.assign(new Error("invalid"), { status: 401 }); };
    for (let i = 0; i < 3; i++) {
      try { await gate.run("old", request); throw Error("accepted"); }
      catch (error) { expect(error.status).to.equal(401); }
    }
    expect(calls).to.equal(1);
    now = 60_001;
    expect(await gate.run("old", async () => "rechecked")).to.equal("rechecked");
    expect(await gate.run("new", async () => "ok")).to.equal("ok");
    for (const status of [403, 429, 500, undefined]) {
      try { await gate.run("temporary", async () => { throw { status }; }); } catch { /* expected upstream rejection */ }
      expect(await gate.run("temporary", async () => "ok")).to.equal("ok");
    }
  });
  it("yields and bounds staging writes, leaving remaining markers for maintenance", async () => {
    let rows = Array.from({ length: 1201 }, (_, _id) => ({ _id }));
    let writes = 0, yielded = false;
    setImmediate(() => { yielded = true; });
    const collection = {
      find: (_filter, options) => ({ toArray: async () => rows.slice(0, options.limit) }),
      updateMany: async (filter, update, options) => {
        expect(filter.repoId).to.equal("repo");
        expect(filter.treeGeneration).to.equal("generation");
        expect(filter.treeStaged).to.equal(true);
        expect(filter._id.$in.length).to.be.at.most(500);
        expect(update).to.deep.equal({ $unset: { treeStaged: "" } });
        expect(options.hint).to.equal("_id_");
        rows = rows.filter(row => !filter._id.$in.includes(row._id));
        writes++;
      },
    };
    await clearStagedRowsInBatches(collection, "repo", "generation", 2);
    expect(rows.length).to.equal(201); expect(writes).to.equal(2); expect(yielded).to.equal(true);
    await clearStagedRowsInBatches(collection, "repo", "generation");
    expect(rows).to.have.length(0);
  });
});

const uri = process.env.PERFORMANCE_MONGO_URI;
(uri ? describe : describe.skip)("indexed submodule checks", function () {
  this.timeout(30000);
  const mongoose = require("mongoose");
  const File = require("../src/core/model/files/files.model").default;
  const { hasVisibleSubmodules } = require("../src/core/file-submodules");
  before(async () => {
    await mongoose.connect(uri);
    await File.createIndexes();
    await File.insertMany(Array.from({length: 12000}, (_, i) => ({
      repoId: "probe", treeGeneration: "current", path: "", name: "file" + i, size: 1,
    })));
  });
  after(async () => { await File.deleteMany({repoId: "probe"}); await mongoose.disconnect(); });
  it("avoids a whole-generation scan when no submodules exist", async () => {
    const executions = [];
    const original = File.exists;
    File.exists = function(filter) {
      const query = original.call(this, filter);
      const exec = query.exec.bind(query);
      query.exec = async function () {
        executions.push(await query.clone().explain("executionStats"));
        return exec();
      };
      return query;
    };
    try {
      expect(await hasVisibleSubmodules("probe", "current")).to.equal(false);
      expect(executions.length).to.equal(2);
      for (const plan of executions) {
        expect(plan.executionStats.totalDocsExamined).to.be.lessThan(10);
        expect(plan.executionStats.totalKeysExamined).to.be.lessThan(10);
      }
    } finally { File.exists = original; }
  });
  it("preserves legacy root manifests and excludes included or other-generation markers", async () => {
    await File.create({repoId:"probe", treeGeneration:"current", path:"", name:"included", submodule:"included"});
    await File.create({repoId:"probe", treeGeneration:"other", path:"", name:"blocked", submodule:"unavailable"});
    expect(await hasVisibleSubmodules("probe","current")).to.equal(false);
    await File.create({repoId:"probe", treeGeneration:"current", path:"", name:"blocked", submodule:"unavailable"});
    expect(await hasVisibleSubmodules("probe","current")).to.equal(true);
    await File.create({repoId:"probe", path:"", name:".gitmodules"});
    expect(await hasVisibleSubmodules("probe")).to.equal(true);
  });
});
