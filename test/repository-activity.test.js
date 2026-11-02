const { expect } = require("chai");
require("ts-node/register/transpile-only");
const db = require("../src/server/database");
const Model = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const Files = require("../src/core/model/files/files.model").default;
const Repository = require("../src/core/Repository").default;
const utils = require("../src/server/routes/route-utils");
const queue = require("../src/queue");

function handler(name, path, method) {
  return require(`../src/server/routes/${name}`).default.stack.find(layer =>
    layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;
}

describe("repository activity dates", () => {
  const restores = [];
  function stub(object, key, value) {
    const original = object[key]; restores.push(() => { object[key] = original; }); object[key] = value;
  }
  afterEach(() => { while (restores.length) restores.pop()(); });
  function repository(status = "ready") {
    return new Repository(new Model({ repoId: "activity", status,
      owner: "507f1f77bcf86cd799439011", anonymizeDate: new Date("2026-01-02"),
      source: { repositoryName: "owner/repo", commit: "abc123", branch: "main", commitDate: new Date("2020-01-01") },
      options: { terms: [], expirationMode: "never" },
    }));
  }
  function auth(repo) {
    stub(utils, "getRepo", async () => repo);
    stub(utils, "getUser", async () => ({ isAdmin: true }));
    stub(utils, "handleError", error => { throw error; });
  }
  it("records readiness after a download, preserves it for progress messages, and advances it after restoration", async () => {
    const repo = repository("download"); let saved;
    stub(db, "isConnected", true);
    stub(Model, "updateOne", (_filter, update) => ({ exec: async () => { saved = update.$set; return { matchedCount: 1 }; } }));
    await repo.updateStatus("ready");
    expect(saved.publishedAt).to.be.instanceOf(Date);
    const first = repo.model.publishedAt;
    await repo.updateStatus("ready", "progress");
    expect(saved).not.to.have.property("publishedAt");
    expect(repo.model.publishedAt).to.deep.equal(first);
    await repo.updateStatus("expired");
    await repo.updateStatus("preparing");
    repo.model.publishedAt = new Date("2026-01-01");
    await repo.updateStatus("ready");
    expect(repo.model.publishedAt.getTime()).to.be.greaterThan(new Date("2026-01-01").getTime());
  });
  it("does not record publication when a concurrent removal cancels the worker", async () => {
    const repo = repository("download"); repo.protectLifecycle = true;
    stub(db, "isConnected", true);
    stub(Model, "updateOne", () => ({ exec: async () => ({ matchedCount: 0 }) }));
    try { await repo.updateStatus("ready"); throw new Error("expected cancellation"); }
    catch (error) { expect(error.message).to.equal("repository_job_cancelled"); }
    expect(repo.model.publishedAt).to.equal(undefined);
  });
  it("dates a settings-only save without rebuilding or changing the commit", async () => {
    const repo = repository(); auth(repo); let saved;
    stub(Model, "updateOne", (_filter, update) => ({ exec: async () => { saved = update.$set; return { matchedCount: 1 }; } }));
    stub(queue, "downloadQueue", { add: async () => { throw new Error("must not rebuild"); } });
    await handler("repository-private", "/:repoId/", "post")({ body: {
      repoId: repo.repoId, fullName: "owner/repo", source: { commit: "abc123", branch: "main" },
      terms: ["author"], options: { expirationMode: "never", image: false },
    } }, { json: () => {} });
    expect(saved.settingsSavedAt).to.be.instanceOf(Date);
    expect(saved.source.commit).to.equal("abc123");
    expect(saved).not.to.have.property("publishedAt");
  });
  it("allows privacy-only saves after hosting capacity or conference admission ends", async () => {
    const repo = repository(); auth(repo);
    stub(require("../src/config").default, "BILLING_ENABLED", true);
    const quotas = require("../src/core/billing/quotas");
    repo.model.billingManaged = true;
    repo.model.conference = "ended-conf";
    repo.model.options.expirationMode = "remove";
    stub(quotas, "assertConferenceAdmission", async () => { throw Error("must not check conference"); });
    stub(quotas, "reserveRepository", async () => { throw Error("must not reserve"); });
    let saved;
    stub(Model, "updateOne", (_filter, update) => ({ exec: async () => { saved = update.$set; return { matchedCount: 1 }; } }));
    await handler("repository-private", "/:repoId/", "post")({ body: {
      repoId: repo.repoId, fullName: "owner/repo", conference: "ended-conf", source: { commit: "abc123", branch: "main" },
      terms: ["private"], options: { expirationMode: "remove", expirationDate: "2027-01-01", image: false, pdf: false, update: false },
    } }, { json: () => {} });
    expect(saved.options).to.include({ image: false, pdf: false, update: false });
  });
  it("rejects an oversized edited source before removing the published files", async () => {
    const repo = repository(); auth(repo); repo.model.billingManaged = true;
    stub(require("../src/config").default, "BILLING_ENABLED", true);
    const quotas = require("../src/core/billing/quotas");
    const access = require("../src/core/github-app");
    const github = require("../src/core/source/GitHubRepository");
    const Stream = require("../src/core/source/GitHubStream").default;
    stub(quotas, "assertConferenceAdmission", async () => {});
    stub(access, "selectRepositoryAccess", async () => ({ token: "test", binding: { kind: "oauth" } }));
    stub(github, "getRepositoryFromGitHub", async () => ({ model: { id: "gh_1" }, fullName: "owner/repo", getCommitInfo: async () => ({ commit: {} }) }));
    stub(Stream.prototype, "getFiles", async function () { expect(this.data.commit).to.equal("abcdef456"); return [{ size: 500 }]; });
    stub(quotas, "reserveRepository", async (_owner, _repo, bytes) => { expect(bytes).to.equal(500); throw Error("quota_exceeded"); });
    repo.remove = async () => { throw Error("must preserve snapshot"); };
    let error;
    try { await handler("repository-private", "/:repoId/", "post")({ body: {
      repoId: repo.repoId, fullName: "owner/repo", source: { commit: "abcdef456", branch: "main" },
      terms: [], options: { expirationMode: "never" },
    } }, { json: () => {} }); } catch (caught) { error = caught; }
    expect(error?.message).to.equal("quota_exceeded");
  });
  for (const mode of ["never", "remove"]) {
    it(`persists the billing deadline when settings change to ${mode}`, async () => {
      const config = require("../src/config").default;
      const expiration = require("../src/core/billing/expiration");
      const quotas = require("../src/core/billing/quotas");
      const repo = repository(); auth(repo); let saved;
      const deadline = new Date("2027-06-01");
      repo.model.options.expirationMode = "remove";
      repo.model.billingNeverExpiresUntil = deadline;
      stub(config, "BILLING_ENABLED", true);
      stub(expiration, "neverExpirationDeadline", async () => deadline);
      stub(quotas, "assertConferenceAdmission", async () => {});
      stub(Model, "updateOne", (_filter, update) => ({ exec: async () => { saved = update; return { matchedCount: 1 }; } }));
      await handler("repository-private", "/:repoId/", "post")({ body: {
        repoId: repo.repoId, fullName: "owner/repo", source: { commit: "abc123", branch: "main" },
        terms: [], options: { expirationMode: mode, expirationDate: "2027-01-01" },
      } }, { json: () => {} });
      if (mode === "never") expect(saved.$set.billingNeverExpiresUntil).to.deep.equal(deadline);
      else expect(saved.$unset).to.have.property("billingNeverExpiresUntil", 1);
    });
  }
  it("rejects repeated extensions beyond one year before changing stored settings", async () => {
    const repo = repository(); auth(repo);
    stub(require("../src/config").default, "BILLING_ENABLED", true);
    repo.model.options.expirationMode = "remove";
    repo.model.options.expirationDate = new Date();
    let writes = 0;
    stub(Model, "updateOne", () => ({ exec: async () => { writes++; return { matchedCount: 1 }; } }));
    const extend = handler("repository-private", "/:repoId/extend", "post");
    await extend({}, { json: () => {} });
    await extend({}, { json: () => {} });
    const savedDate = repo.model.options.expirationDate;
    let error;
    try { await extend({}, { json: () => {} }); } catch (caught) { error = caught; }
    expect(error?.message).to.equal("invalid_billing_expiration");
    expect(writes).to.equal(2);
    expect(repo.model.options.expirationDate).to.deep.equal(savedDate);
  });
  it("does not extend an expired submission in a conference that no longer admits it", async () => {
    const repo = repository("expired"); auth(repo);
    repo.model.conference = "ended";
    const quotas = require("../src/core/billing/quotas");
    stub(quotas, "assertConferenceAdmission", async (_owner, _id, conference) => {
      expect(conference).to.equal("ended"); throw Error("conf_not_activated");
    });
    stub(Model, "updateOne", () => { throw Error("must not persist extension"); });
    let error;
    try { await handler("repository-private", "/:repoId/extend", "post")({}, {}); } catch (caught) { error = caught; }
    expect(error?.message).to.equal("conf_not_activated");
    expect(repo.status).to.equal("expired");
  });
  it("dates a dashboard expiration extension", async () => {
    const repo = repository(); auth(repo); let saved;
    stub(Model, "updateOne", (_filter, update) => ({ exec: async () => { saved = update.$set; } }));
    await handler("repository-private", "/:repoId/extend", "post")({}, { json: () => {} });
    expect(saved.settingsSavedAt).to.be.instanceOf(Date);
    expect(saved["options.expirationDate"]).to.be.instanceOf(Date);
  });
  for (const action of ["save", "extend"]) {
    for (const outcome of ["success", "failure", "concurrent removal"]) {
      it(`${action} restores atomically and handles enqueue ${outcome}`, async () => {
        const repo = repository(action === "save" ? "removed" : "expired");
        auth(repo);
        const stored = repo.model.toObject();
        let writes = 0, responded = false, queued = false;
        stub(Model, "updateOne", (filter, update) => ({ exec: async () => {
          if (!require("sift").default(filter)(stored)) return { matchedCount: 0 };
          // Mongoose omits undefined values from $set before sending it.
          for (const [key, value] of Object.entries(update.$set)) {
            if (value !== undefined) stored[key] = value;
          }
          writes++;
          return { matchedCount: 1 };
        } }));
        const failure = new Error("queue unavailable");
        stub(queue, "downloadQueue", { add: async () => {
          expect(responded).to.equal(false);
          expect(writes).to.equal(1);
          expect(stored.status).to.equal("preparing");
          expect(stored.anonymizeDate.getTime()).to.be.greaterThan(new Date("2026-01-02").getTime());
          if (outcome === "concurrent removal") stored.status = "removing";
          if (outcome !== "success") throw failure;
          queued = true;
        } });
        let caught;
        try {
          await handler("repository-private", action === "save" ? "/:repoId/" : "/:repoId/extend", "post")({ body: {
            repoId: repo.repoId, fullName: "owner/repo", source: { commit: "abc123", branch: "main" },
            terms: [], options: { expirationMode: "never" },
          } }, { json: () => { expect(queued).to.equal(true); responded = true; } });
        } catch (error) { caught = error; }
        expect(caught).to.equal(outcome === "success" ? undefined : failure);
        expect(responded).to.equal(outcome === "success");
        expect(stored.status).to.equal(outcome === "success" ? "preparing" : outcome === "failure" ? "error" : "removing");
      });
    }
  }
  it("returns publication and settings dates independently of the older source commit", async () => {
    const repo = repository(); auth(repo);
    repo.model.settingsSavedAt = new Date("2026-03-01");
    repo.model.publishedAt = new Date("2026-02-01");
    stub(Files, "exists", async () => null);
    let body;
    await handler("repository-public", "/:repoId/options", "get")({}, { header: () => {}, json: value => { body = value; } });
    expect(body.lastUpdateDate).to.deep.equal(repo.model.settingsSavedAt);
    expect(body.sourceCommitDate).to.deep.equal(new Date("2020-01-01"));
    expect(body.publishedAt).to.deep.equal(repo.model.publishedAt);
  });
  it("does not invent publication or settings dates for legacy repositories", async () => {
    const repo = repository(); auth(repo);
    stub(Files, "exists", async () => null);
    let body;
    await handler("repository-public", "/:repoId/options", "get")({}, { header: () => {}, json: value => { body = value; } });
    expect(body.publishedAt).to.equal(undefined);
    expect(body.settingsSavedAt).to.equal(undefined);
    expect(body.lastUpdateDate).to.deep.equal(repo.model.anonymizeDate);
    expect(body.expirationDate).to.equal(null);
  });
  it("tells reviewers when an expiring repository stops being available", async () => {
    const repo = repository(); auth(repo);
    repo.model.options.expirationMode = "remove";
    repo.model.options.expirationDate = new Date("2099-01-01");
    stub(Files, "exists", async () => null);
    let body;
    await handler("repository-public", "/:repoId/options", "get")({}, { header: () => {}, json: value => { body = value; } });
    expect(body.expirationDate).to.deep.equal(new Date("2099-01-01"));
  });
});
