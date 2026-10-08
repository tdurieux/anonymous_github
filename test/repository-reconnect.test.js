const { expect } = require("chai");
require("ts-node/register/transpile-only");
const Repository = require("../src/core/Repository").default;
const Model = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const utils = require("../src/server/routes/route-utils");
const github = require("../src/core/source/GitHubRepository");
const app = require("../src/core/github-app");
const tokens = require("../src/core/GitHubUtils");
const db = require("../src/server/database");
const queue = require("../src/queue");
const router = require("../src/server/routes/repository-private").default;
const handler = (path, method = "get") => router.stack.find(layer =>
  layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;

describe("reconnecting a recreated repository", () => {
  const restores = [];
  function stub(object, key, value) {
    const original = object[key]; restores.push(() => { object[key] = original; }); object[key] = value;
  }
  let repo, user, fresh, selected, writes, removals, jobs, commitChecks;
  beforeEach(() => {
    repo = new Repository(new Model({ repoId: "recreated", status: "ready",
      owner: "507f1f77bcf86cd799439011",
      githubAccess: { kind: "github-app", publicRead: true, repositoryId: 1380842178, revision: "old" },
      source: { repositoryName: "owner/repo", repositoryId: "old-record", branch: "main", commit: "deadbeef" },
      options: { terms: ["author"], expirationMode: "never" },
    }));
    user = { id: repo.owner.id, model: { id: repo.owner.id } };
    selected = { token: "fresh-token", binding: { kind: "github-app", publicRead: true, repositoryId: 1396237353, revision: "fresh" } };
    writes = []; removals = []; jobs = []; commitChecks = [];
    fresh = { id: "gh_1396237353", model: { id: "new-record" }, fullName: "owner/repo",
      toJSON: () => ({ externalId: "gh_1396237353" }),
      branches: async () => [{ name: "main", commit: "abcdef" }],
      readme: async () => "replacement readme",
      getCommitInfo: async sha => { commitChecks.push(sha); return { commit: { committer: { date: "2026-09-29T00:00:00Z" } } }; },
    };
    stub(utils, "getRepo", async () => repo);
    stub(utils, "getUser", async () => user);
    stub(utils, "handleError", error => { throw error; });
    stub(db, "getRepository", async () => repo);
    stub(app, "selectRepositoryAccess", async (owner, name, kind) => {
      expect([owner, name, kind]).to.deep.equal([repo.owner.id, "owner/repo", "github-app"]);
      return selected;
    });
    stub(app, "boundAppToken", async () => { throw new Error("old binding is inaccessible"); });
    stub(tokens, "getToken", async () => { throw new Error("old binding is inaccessible"); });
    stub(github, "getRepositoryFromGitHub", async options => {
      expect(options.accessToken).to.equal("fresh-token");
      expect(options.force).to.equal(true);
      expect(options.repositoryID).to.equal(undefined);
      return fresh;
    });
    stub(Model, "updateOne", (filter, update) => ({ exec: async () => {
      writes.push({ filter, update }); return { matchedCount: 1 };
    } }));
    repo.remove = async options => { removals.push(options); };
    repo.updateStatus = async status => { repo.model.status = status; };
    stub(queue, "downloadQueue", { add: async (...args) => { jobs.push(args); } });
  });
  afterEach(() => { while (restores.length) restores.pop()(); });
  function preview(query = {}) {
    return { params: { owner: "owner", repo: "repo" }, query: {
      anonymizedRepoId: repo.repoId, repositoryID: "old-record", reconnect: "1", ...query,
    } };
  }
  function form(extra = {}) {
    return { body: { repoId: repo.repoId, fullName: "owner/repo", reconnectRepositoryId: "gh_1396237353",
      source: { branch: "main", commit: "abcdef" }, terms: ["author"], options: { expirationMode: "never" }, ...extra } };
  }
  async function failure(work, message) {
    let error;
    try { await work(); } catch (caught) { error = caught; }
    expect(error?.message).to.equal(message);
    expect(writes).to.have.length(0);
    expect(removals).to.have.length(0);
    expect(jobs).to.have.length(0);
  }

  for (const path of ["/:owner/:repo/", "/:owner/:repo/branches", "/:owner/:repo/readme"]) {
    it(`previews ${path} with fresh access without changing the anonymization`, async () => {
      let result;
      await handler(path)(preview(), { json: value => { result = value; }, send: value => { result = value; } });
      expect(result).not.to.equal(undefined);
      expect(repo.model.githubAccess.repositoryId).to.equal(1380842178);
      expect(writes).to.have.length(0);
    });
    it(`keeps the bound identity for ordinary ${path} requests`, async () => {
      await failure(() => handler(path)(preview({ reconnect: undefined }), {}), "old binding is inaccessible");
    });
    it(`denies a non-owner reconnect preview at ${path}`, async () => {
      user = { id: "admin", isAdmin: true };
      await failure(() => handler(path)(preview(), {}), "not_owner");
    });
  }

  it("rebinds the source and downloads the replacement even when the old commit no longer exists", async () => {
    await handler("/:repoId/", "post")(form(), { json: () => {} });
    expect(commitChecks).to.deep.equal(["abcdef"]);
    expect(writes).to.have.length(1);
    const saved = writes[0];
    expect(saved.filter["githubAccess.revision"]).to.equal("old");
    expect(saved.update.$set.githubAccess.repositoryId).to.equal(1396237353);
    expect(saved.update.$set.githubAccess.revision).not.to.equal("old");
    expect(saved.update.$set.source.repositoryId).to.equal("new-record");
    expect(saved.update.$set.source.commit).to.equal("abcdef");
    expect(saved.update.$set.source.commitDate).to.deep.equal(new Date("2026-09-29T00:00:00Z"));
    expect(removals).to.deep.equal([{ accessRevision: "old" }]);
    expect(jobs[0][1]).to.deep.equal({ repoId: "recreated" });
  });
  it("rebuilds when only the repository identity changed", async () => {
    await handler("/:repoId/", "post")(form({ source: { branch: "main", commit: "deadbeef" } }), { json: () => {} });
    expect(jobs).to.have.length(1);
  });
  it("does not reconnect implicitly on an ordinary edit", async () => {
    await failure(() => handler("/:repoId/", "post")(form({ reconnectRepositoryId: undefined }), {}), "old binding is inaccessible");
  });
  it("rejects a non-owner save", async () => {
    user = { id: "admin", isAdmin: true };
    await failure(() => handler("/:repoId/", "post")(form(), {}), "not_owner");
  });
  it("rejects a coauthor's reconnect preview and save", async () => {
    repo.model.coauthors = [{ username: "coauthor", githubId: "42" }];
    user = { id: "other", username: "coauthor", model: { id: "other", externalIDs: { github: "42" } } };
    await failure(() => handler("/:owner/:repo/branches")(preview(), {}), "not_owner");
    await failure(() => handler("/:repoId/", "post")(form(), {}), "not_owner");
  });
  it("does not remove files if the connection changed during validation", async () => {
    repo.remove = Repository.prototype.remove.bind(repo);
    repo.resetSate = async () => { throw new Error("must not remove files"); };
    stub(Model, "updateOne", async () => ({ matchedCount: 0 }));
    await failure(() => handler("/:repoId/", "post")(form(), {}), "connection_changed");
  });
  it("rejects replacement after the owner previewed the repository", async () => {
    fresh.id = "gh_999999";
    await failure(() => handler("/:repoId/", "post")(form(), {}), "connection_changed");
  });
  it("rejects a binding that differs from the resolved repository", async () => {
    selected.binding.repositoryId = 999999;
    await failure(() => handler("/:repoId/", "post")(form(), {}), "connection_changed");
  });
  it("preserves the snapshot when new access is denied", async () => {
    stub(app, "selectRepositoryAccess", async () => { throw new Error("github_app_access_required"); });
    await failure(() => handler("/:repoId/", "post")(form(), {}), "github_app_access_required");
  });
  it("rejects a missing replacement branch", async () => {
    fresh.branches = async () => [];
    await failure(() => handler("/:repoId/", "post")(form(), {}), "branch_not_specified");
  });
  it("preserves the snapshot when the selected commit is inaccessible", async () => {
    fresh.getCommitInfo = async () => { throw new Error("commit_not_found"); };
    await failure(() => handler("/:repoId/", "post")(form(), {}), "commit_not_found");
  });
  for (const status of ["preparing", "queue", "download", "removing", "expiring"]) {
    it(`does not reconnect during ${status}`, async () => {
      repo.model.status = status;
      await failure(() => handler("/:repoId/", "post")(form(), {}), "invalid_status");
    });
  }
});
