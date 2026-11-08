const { expect } = require("chai");
require("ts-node/register/transpile-only");
const notifications = require("../src/core/owner-notifications");
const utils = require("../src/server/routes/route-utils");
const app = require("../src/core/github-app");
const db = require("../src/server/database");
const github = require("../src/core/source/GitHubRepository");
const Resources = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const Sources = require("../src/core/model/repositories/repositories.model").default;
const Users = require("../src/core/model/users/users.model").default;
const repositoryRouter = require("../src/server/routes/repository-private").default;
const appRouter = require("../src/server/routes/github-app").githubAppRouter;
const handler = (router, path) => router.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle;

describe("owner actions rearm access alerts", () => {
  let restores, resets;
  const owner = "507f1f77bcf86cd799439011";
  function stub(object, key, value) {
    const old = object[key]; restores.push(() => { object[key] = old; }); object[key] = value;
  }
  beforeEach(() => {
    restores = []; resets = [];
    stub(utils, "getUser", async () => ({ id: owner, model: { id: owner } }));
    stub(utils, "handleError", error => { throw error; });
    stub(notifications, "resetOwnerAccessAlerts", async (...args) => { resets.push(args); });
  });
  afterEach(() => { while (restores.length) restores.pop()(); });

  for (const isOwner of [true, false]) it(`extension ${isOwner ? "rearms for its owner" : "does not rearm for an admin"}`, async () => {
    const id = isOwner ? owner : "admin";
    stub(utils, "getUser", async () => ({ id, model: { id }, isAdmin: !isOwner }));
    const repo = { owner: { id: owner }, status: "ready", model: { _id: "resource", options: {} } };
    stub(utils, "getRepo", async () => repo);
    stub(Resources, "updateOne", () => ({ exec: async () => ({ matchedCount: 1 }) }));
    await handler(repositoryRouter, "/:repoId/extend")({}, { json() {} });
    expect(resets).to.deep.equal(isOwner ? [[owner, { kind: "repository", id: "resource" }]] : []);
  });

  it("clears the previous owner's claim atomically when a repository is claimed", async () => {
    stub(db, "getRepository", async () => ({ repoId: "resource", model: { source: { repositoryId: "source" } } }));
    stub(app, "selectRepositoryAccess", async () => ({ token: "token", binding: { kind: "oauth" } }));
    stub(github, "getRepositoryFromGitHub", async () => ({ id: 42 }));
    stub(Sources, "findById", async () => ({ externalId: 42 }));
    let write;
    stub(Resources, "updateOne", (_filter, update) => ({ collation: async () => { write = update; } }));
    await handler(repositoryRouter, "/claim")({ body: { repoId: "resource", repoUrl: "https://github.com/owner/repo" }, query: {} }, { send() {} });
    expect(write.$set.owner).to.equal(owner);
    expect(write.$set.accessAlertGeneration).to.be.a("string");
    expect(write.$unset).to.have.property("accessAlertClaimedAt");
  });

  for (const action of ["install", "request", "unverified"]) it(`handles ${action} installation completion without premature resets`, async () => {
    stub(app, "userInstallations", async () => [{ id: 42 }]);
    stub(Users, "updateOne", async () => ({}));
    const req = { session: {
      githubInstallFlow: { ownerId: owner, state: "state", expires: Date.now() + 60000, returnTo: "/connections" },
      save: callback => callback(),
    }, isAuthenticated: () => true, query: { state: "state", setup_action: action, installation_id: action === "unverified" ? "99" : "42" } };
    let failure;
    try { await handler(appRouter, "/app/setup")(req, { redirect() {} }); } catch (error) { failure = error; }
    expect(resets).to.deep.equal(action === "install" ? [[owner]] : []);
    if (action === "unverified") expect(failure?.message).to.equal("github_app_access_required");
    else expect(failure).to.equal(undefined);
  });
});
