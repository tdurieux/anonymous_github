const { expect } = require("chai");
require("ts-node/register/transpile-only");
const db = require("../src/server/database");
const gh = require("../src/core/GitHubUtils");
const notifications = require("../src/core/owner-notifications");
const utils = require("../src/server/routes/route-utils");
const queue = require("../src/queue");
const AnonymousError = require("../src/core/AnonymousError").default;
const { repositoryFailureStatus } = require("../src/core/repository-failure-status");
const { UnrecoverableError } = require("bullmq");

describe("quota job failures", () => {
  const restores = [];
  function stub(object, key, value) {
    const previous = object[key]; object[key] = value; restores.push(() => { object[key] = previous; });
  }
  afterEach(() => { while (restores.length) restores.pop()(); });
  function repository() {
    return { repoId: "quota-test", status: "error", statusActivityDate: new Date(0),
      owner: { id: "owner" }, options: {}, model: { owner: "owner", statusMessage: "quota_exceeded" },
      assertNotArchived() {},
      async updateStatus(status, message) { this.status = status; this.model.statusMessage = message; },
      async resetSate() {},
    };
  }
  it("maps stored quota errors to 402, leaving unknown failures as 500", () => {
    expect(repositoryFailureStatus("quota_exceeded")).to.equal(402);
    expect(repositoryFailureStatus("unexpected")).to.equal(500);
  });
  it("does not let public reads retry an old quota denial", async () => {
    const repo = repository(); let enqueues = 0; let writes = 0;
    stub(utils, "getRepo", async () => repo);
    stub(utils, "getUser", async () => { throw Error("not_connected"); });
    stub(queue, "downloadQueue", { add: async () => { enqueues++; } });
    stub(repo, "updateStatus", async () => { writes++; });
    const route = require("../src/server/routes/repository-public").default.stack.find(l => l.route?.path === "/:repoId/options").route.stack[0].handle;
    for (let i = 0; i < 2; i++) {
      let status, body;
      await route({}, { header() {}, status(value) { status = value; return this; }, json(value) { body = value; } });
      expect(status).to.equal(402); expect(body).to.deep.equal({ error: "quota_exceeded" });
    }
    expect(enqueues).to.equal(0); expect(writes).to.equal(0);
  });
  for (const code of ["quota_exceeded", "github_unavailable"]) {
    it(`classifies ${code} at the worker boundary and preserves its status message`, async () => {
      const repo = repository(); const failure = new AnonymousError(code, { httpStatus: code === "quota_exceeded" ? 402 : 502 });
      stub(db, "connect", async () => {}); stub(db, "getRepository", async () => repo);
      stub(gh, "getToken", async () => "test-token"); stub(gh, "getRedisGateResetAt", async () => 0);
      stub(notifications, "notifyOwnerAccessProblem", async () => {});
      repo.anonymize = async () => { throw failure; };
      const error = await require("../src/queue/processes/downloadRepository").default({ data: { repoId: repo.repoId }, updateProgress() {} }).catch(error => error);
      expect(repo.status).to.equal("error"); expect(repo.model.statusMessage).to.equal(code);
      if (code === "quota_exceeded") expect(error).to.be.instanceOf(UnrecoverableError);
      else expect(error).to.equal(failure);
    });
  }
  it("allows an authenticated owner to explicitly retry quota admission", async () => {
    const repo = repository(); let refreshes = 0;
    repo.refresh = async () => { refreshes++; };
    stub(utils, "getRepo", async () => repo);
    stub(utils, "getUser", async () => ({ id: "owner", model: { id: "owner" } }));
    stub(notifications, "resetOwnerAccessAlerts", async () => {});
    const route = require("../src/server/routes/repository-private").default.stack.find(l => l.route?.path === "/:repoId/refresh").route.stack[0].handle;
    let body;
    await route({}, { json(value) { body = value; } });
    expect(refreshes).to.equal(1); expect(body).to.deep.equal({ status: "error" });
  });
});
