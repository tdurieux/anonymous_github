const { expect } = require("chai");
require("ts-node/register/transpile-only");
const Repository = require("../src/core/Repository").default;
const Model = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const utils = require("../src/server/routes/route-utils");
const github = require("../src/core/source/GitHubRepository");
const queue = require("../src/queue");
const db = require("../src/server/database");
const router = require("../src/server/routes/repository-private").default;
const refresh = router.stack.find(layer => layer.route?.path === "/:repoId/refresh").route.stack[0].handle;

describe("repository refresh and restoration", () => {
  const restores = [];
  function stub(object, key, value) {
    const original = object[key];
    restores.push(() => { object[key] = original; });
    object[key] = value;
  }
  afterEach(() => { while (restores.length) restores.pop()(); });
  function repository(status) {
    const repo = new Repository(new Model({ repoId: "restore-me", status,
      statusDate: new Date(),
      owner: "507f1f77bcf86cd799439011",
      source: { repositoryName: "owner/repo", branch: "main", commit: "saved-sha" },
      options: { expirationMode: "never" },
    }));
    stub(utils, "getRepo", async () => repo);
    stub(utils, "getUser", async () => ({ isAdmin: true, model: { id: "admin" } }));
    stub(utils, "handleError", error => { throw error; });
    return repo;
  }

  for (const status of ["preparing", "queue", "download", "removing", "expiring"]) {
    it(`responds with a conflict during ${status} without starting another update`, async () => {
      const repo = repository(status);
      repo.updateIfNeeded = async () => { throw new Error("must not update"); };
      let failure;
      try { await refresh({}, {}); } catch (error) { failure = error; }
      expect(failure?.message).to.equal("invalid_status");
      expect(failure.httpStatus).to.equal(409);
    });
  }

  it("checks ownership before returning an operation status", async () => {
    repository("preparing");
    stub(utils, "getUser", async () => ({ model: { id: "other" } }));
    let failure;
    try { await refresh({}, {}); } catch (error) { failure = error; }
    expect(failure?.message).to.equal("not_authorized");
    expect(failure.httpStatus).to.equal(403);
  });

  for (const commit of ["saved-sha", "new-sha"]) {
    it(`rebuilds a removed repository at ${commit} while preserving its ID`, async () => {
      const repo = repository("removed");
      stub(db, "isConnected", false);
      repo.getToken = async () => "test-token";
      stub(github, "getRepositoryFromGitHub", async () => ({
        fullName: "owner/repo", model: { defaultBranch: "main" },
        branches: async () => [{ name: "main", commit }],
        getCommitInfo: async () => ({ commit: {} }),
      }));
      repo.resetSate = async () => {};
      let added;
      stub(queue, "downloadQueue", { getJob: async () => undefined, add: async (...args) => { added = args; } });
      let response;
      await refresh({}, { json: body => { response = body; } });
      expect(response.status).to.equal("preparing");
      expect(repo.model.source.commit).to.equal(commit);
      expect(repo.repoId).to.equal("restore-me");
      expect(added[1]).to.deep.equal({ repoId: "restore-me" });
    });
  }

  it("preserves a removed repository and reports a GitHub access failure", async () => {
    const repo = repository("removed");
    const failure = new Error("token_expired");
    repo.getToken = async () => { throw failure; };
    stub(queue, "downloadQueue", { getJob: async () => undefined, add: async () => { throw new Error("must not enqueue"); } });
    let caught;
    try { await refresh({}, {}); } catch (error) { caught = error; }
    expect(caught).to.equal(failure);
    expect(repo.status).to.equal("removed");
    expect(repo.model.source.commit).to.equal("saved-sha");
  });

  it("allows a stale download to be retried", async () => {
    const repo = repository("download");
    repo.model.statusDate = new Date(Date.now() - 6 * 60_000);
    let retried = false;
    repo.refresh = async () => { retried = true; };
    await refresh({}, { json: () => {} });
    expect(retried).to.equal(true);
  });

  function database(repo) {
    const stored = repo.model.toObject();
    stub(db, "isConnected", true);
    stub(queue, "downloadQueue", { getJob: async () => undefined });
    const matches = filter => require("sift").default(filter)(stored);
    stub(Model, "updateOne", (filter, update) => ({ exec: async () => {
      if (!matches(filter)) return { matchedCount: 0 };
      for (const [key, value] of Object.entries(update.$set || {})) {
        const parts = key.split(".");
        let target = stored;
        while (parts.length > 1) { const part = parts.shift(); target = target[part] ||= {}; }
        target[parts[0]] = value;
      }
      for (const key of Object.keys(update.$unset || {})) delete stored[key];
      return { matchedCount: 1 };
    } }));
    stub(Model, "exists", async filter => matches(filter) ? { _id: stored._id } : null);
    return stored;
  }

  it("claims a lease before GitHub work and rejects a concurrent refresh", async () => {
    const first = repository("ready");
    const second = new Repository(new Model(first.model.toObject()));
    const stored = database(first);
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    first.updateIfNeeded = async () => {
      started();
      await new Promise(resolve => { release = resolve; });
    };
    second.updateIfNeeded = async () => { throw new Error("must not start another refresh"); };
    const running = first.refresh();
    await entered;
    try {
      let failure;
      try { await second.refresh(); } catch (error) { failure = error; }
      expect(failure?.message).to.equal("invalid_status");
      expect(stored.status).to.equal("ready");
    } finally { release(); await running; }
    expect(stored).not.to.have.property("refreshToken");
  });

  it("releases a failed lease so reconnecting can be retried", async () => {
    const repo = repository("removed");
    const stored = database(repo);
    const failure = new Error("token_expired");
    repo.getToken = async () => { throw failure; };
    let caught;
    try { await repo.refresh(); } catch (error) { caught = error; }
    expect(caught).to.equal(failure);
    expect(stored).not.to.have.property("refreshToken");
    expect(stored.status).to.equal("removed");
    repo.updateIfNeeded = async () => {};
    await repo.refresh();
  });

  it("reclaims an expired lease without letting the old request write or release it", async () => {
    const old = repository("ready");
    const stored = database(old);
    const replacement = new Repository(new Model(old.model.toObject()));
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    old.updateIfNeeded = async () => {
      started();
      await new Promise(resolve => { release = resolve; });
      await old.updateStatus("preparing");
    };
    const running = old.refresh().catch(error => error);
    await entered;
    stored.refreshUntil = new Date(0);
    replacement.updateIfNeeded = async () => {
      const replacementToken = stored.refreshToken;
      release();
      expect((await running).message).to.equal("invalid_status");
      expect(stored.refreshToken).to.equal(replacementToken);
    };
    await replacement.refresh();
    expect(stored.status).to.equal("ready");
  });

  for (const status of ["removing", "expiring", "archived"]) {
    it(`does not overwrite ${status} requested during a GitHub lookup`, async () => {
      const repo = repository("ready");
      const stored = database(repo);
      repo.getToken = async () => "token";
      stub(github, "getRepositoryFromGitHub", async () => ({
        fullName: "owner/repo", model: {},
        branches: async () => {
          stored.status = status;
          return [{ name: "main", commit: "new-sha" }];
        },
        getCommitInfo: async () => ({ commit: {} }),
      }));
      repo.resetSate = async () => { throw new Error("must not delete cache"); };
      stub(queue, "downloadQueue", { getJob: async () => undefined, add: async () => { throw new Error("must not enqueue"); } });
      let failure;
      try { await repo.refresh(); } catch (error) { failure = error; }
      expect(failure?.message).to.equal("invalid_status");
      expect(stored.status).to.equal(status);
      expect(stored.source.commit).to.equal("saved-sha");
    });
  }

  for (const removedDuringReset of [false, true]) {
    it(`rebuilds under a lease, removal during reset: ${removedDuringReset}`, async () => {
      const repo = repository("removed");
      const stored = database(repo);
      repo.getToken = async () => "token";
      stub(github, "getRepositoryFromGitHub", async () => ({
        fullName: "owner/repo", model: {},
        branches: async () => [{ name: "main", commit: "saved-sha" }],
        getCommitInfo: async () => ({ commit: {} }),
      }));
      repo.resetSate = async () => {
        if (removedDuringReset) stored.status = "removing";
      };
      let added = false;
      stub(queue, "downloadQueue", { getJob: async () => undefined, add: async () => { added = true; } });
      let failure;
      try { await repo.refresh(); } catch (error) { failure = error; }
      expect(added).to.equal(!removedDuringReset);
      expect(stored.status).to.equal(removedDuringReset ? "removing" : "preparing");
      expect(failure?.message).to.equal(removedDuringReset ? "invalid_status" : undefined);
      expect(stored).not.to.have.property("refreshToken");
    });
  }

  for (const state of ["active", "waiting", "delayed", "prioritized", "waiting-children"]) {
    it(`rejects a stale download with a ${state} job before touching its snapshot`, async () => {
      const repo = repository("download");
      repo.model.statusDate = new Date(Date.now() - 6 * 60_000);
      const stored = database(repo);
      stub(queue, "downloadQueue", { getJob: async () => ({ getState: async () => state }) });
      repo.updateIfNeeded = async () => { throw new Error("must not refresh"); };
      let failure;
      try { await repo.refresh(); } catch (error) { failure = error; }
      expect(failure?.message).to.equal("invalid_status");
      expect(stored.status).to.equal("download");
      expect(stored.source.commit).to.equal("saved-sha");
    });
  }

  for (const state of ["completed", "failed"]) {
    it(`removes a ${state} download job before reusing its ID`, async () => {
      const repo = repository("download");
      database(repo);
      let removed = false;
      stub(queue, "downloadQueue", { getJob: async () => ({
        getState: async () => state, remove: async () => { removed = true; },
      }) });
      repo.updateIfNeeded = async () => { expect(removed).to.equal(true); };
      await repo.refresh();
    });
  }

  it("keeps a snapshot retryable if the lease expires after the commit update", async () => {
    const repo = repository("ready");
    const stored = database(repo);
    repo.getToken = async () => "token";
    stub(github, "getRepositoryFromGitHub", async () => ({
      fullName: "owner/repo", model: {},
      branches: async () => [{ name: "main", commit: "new-sha" }],
      getCommitInfo: async () => ({ commit: {} }),
    }));
    repo.resetSate = async () => {
      expect(stored.source.commit).to.equal("new-sha");
      expect(stored.status).to.equal("preparing");
      stored.refreshUntil = new Date(0);
    };
    let failure;
    try { await repo.refresh(); } catch (error) { failure = error; }
    expect(failure?.message).to.equal("invalid_status");
    expect(stored.status).to.equal("error");
    expect(stored).not.to.have.property("refreshToken");

    const retry = new Repository(new Model(stored));
    retry.getToken = async () => "token";
    let cleared = false, queued = false;
    retry.resetSate = async () => { cleared = true; };
    stub(queue, "downloadQueue", { getJob: async () => undefined, add: async () => { queued = true; } });
    await retry.refresh();
    expect(cleared).to.equal(true);
    expect(queued).to.equal(true);
    expect(stored.status).to.equal("preparing");
  });

  it("serves the dashboard polling URL with repository status", async () => {
    const repo = repository("ready");
    stub(db, "getRepository", async () => repo);
    stub(require("../src/core/GitHubUtils"), "getToken", async () => { throw new Error("token_expired"); });
    const express = require("express");
    const app = express();
    app.use((req, _res, next) => { req.isAuthenticated = () => true; next(); });
    app.use("/api/repo", require("../src/server/routes/repository-public").default);
    app.use("/api/repo", require("../src/server/routes/file").default);
    app.use("/api/repo", router);
    const server = await new Promise(resolve => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    try {
      const response = await new Promise((resolve, reject) => {
        require("http").get({ host: "127.0.0.1", port: server.address().port, path: "/api/repo/restore-me" }, res => {
          let body = "";
          res.on("data", chunk => { body += chunk; });
          res.on("end", () => {
            try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
            catch (error) { reject(error); }
          });
        }).on("error", reject);
      });
      expect(response.status).to.equal(200);
      expect(response.data.status).to.equal("ready");
      expect(response.data.connectionError).to.equal("token_expired");
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

});
