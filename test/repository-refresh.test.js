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
      owner: "507f1f77bcf86cd799439011",
      source: { repositoryName: "owner/repo", branch: "main", commit: "saved-sha" },
      options: { expirationMode: "never" },
    }));
    stub(utils, "getRepo", async () => repo);
    stub(utils, "getUser", async () => ({ isAdmin: true }));
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
      repo.resetSate = async status => { repo.model.status = status; };
      let added;
      stub(queue, "downloadQueue", { add: async (...args) => { added = args; } });
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
    stub(queue, "downloadQueue", { add: async () => { throw new Error("must not enqueue"); } });
    let caught;
    try { await refresh({}, {}); } catch (error) { caught = error; }
    expect(caught).to.equal(failure);
    expect(repo.status).to.equal("removed");
    expect(repo.model.source.commit).to.equal("saved-sha");
  });
});
