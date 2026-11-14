const { expect } = require("chai");
const { setImmediate } = require("timers");
require("ts-node/register/transpile-only");
const db = require("../src/server/database");
const Model = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const Repository = require("../src/core/Repository").default;
const gh = require("../src/core/GitHubUtils");
const sift = require("sift").default;

describe("download progress publication fences", function () {
  const restores = [];
  function stub(object, key, value) { const before = object[key]; restores.push(() => { object[key] = before; }); object[key] = value; }
  afterEach(() => { while (restores.length) restores.pop()(); });
  function setup() {
    const model = new Model({ repoId: "progress-test", status: "download", statusDate: new Date(1000),
      owner: "507f1f77bcf86cd799439011", anonymizeDate: new Date(500),
      source: { repositoryName: "owner/repo", commit: "abc", branch: "main" }, options: { terms: [], expirationMode: "never" } });
    const repo = new Repository(model); repo.protectLifecycle = true;
    const stored = model.toObject();
    stub(db, "isConnected", true);
    stub(Model, "updateOne", (filter, update) => ({ exec: async () => {
      if (!sift(filter)(stored)) return { matchedCount: 0 };
      Object.assign(stored, update.$set); return { matchedCount: 1 };
    } }));
    return { repo, stored };
  }

  it("keeps a captured publication fence valid when a queue progress tick runs", async function () {
    const { repo, stored } = setup(); let tick;
    stub(global, "setInterval", callback => { tick = callback; return { unref() {} }; });
    stub(global, "clearInterval", () => {});
    stub(db, "connect", async () => {});
    stub(db, "getRepository", async () => repo);
    stub(gh, "getToken", async () => "test-token");
    stub(gh, "getRedisGateResetAt", async () => 0);
    stub(repo, "resetSate", async () => {});
    stub(repo, "anonymize", async progress => {
      const fence = { status: stored.status, statusDate: stored.statusDate };
      progress("Writing files"); tick();
      await new Promise(resolve => setImmediate(resolve));
      expect(sift(fence)(stored), "progress invalidated the publication fence").to.equal(true);
      expect(stored.statusMessage).to.equal("Writing files");
    });
    await require("../src/queue/processes/downloadRepository").default({ data: { repoId: repo.repoId }, updateProgress: async () => {} });
    expect(stored.status).to.equal("ready");
  });

  it("keeps fresh long-running downloads busy without changing statusDate", async function () {
    const { repo, stored } = setup(); const before = repo.model.statusDate;
    await repo.updateProgressMessage("Writing files");
    expect(stored.statusDate).to.deep.equal(before);
    expect(repo.model.statusDate).to.deep.equal(before);
    expect(repo.statusActivityDate.getTime()).to.be.greaterThan(Date.now() - 1000);
    try { await repo.check(); throw new Error("expected not ready"); }
    catch (error) { expect(error.message).to.equal("repository_not_ready"); }
  });

  for (const replacement of ["ready", "removed", "download"]) {
    it(`does not overwrite progress for a newer ${replacement} state`, async function () {
      const { repo, stored } = setup();
      stored.status = replacement; stored.statusDate = new Date(2000); stored.statusMessage = "new operation";
      await repo.updateProgressMessage("old progress");
      expect(stored.statusMessage).to.equal("new operation");
      expect(repo.model.statusMessage).not.to.equal("old progress");
      expect(stored).not.to.have.property("progressDate");
    });
  }

  it("does not apply a completed progress write to a locally advanced status", async function () {
    const { repo } = setup();
    stub(Model, "updateOne", () => ({ exec: async () => {
      repo.model.status = "ready"; repo.model.statusDate = new Date(2000); repo.model.statusMessage = "done";
      return { matchedCount: 1 };
    } }));
    await repo.updateProgressMessage("old progress");
    expect(repo.model.statusMessage).to.equal("done");
  });
});
