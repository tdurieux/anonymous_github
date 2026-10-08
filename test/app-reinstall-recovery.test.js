const { expect } = require("chai");
require("ts-node/register/transpile-only");
const config = require("../src/config").default;
const app = require("../src/core/github-app");
const utils = require("../src/server/routes/route-utils");
const Repositories = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const PullRequests = require("../src/core/model/anonymizedPullRequests/anonymizedPullRequests.model").default;
const { githubAppRouter } = require("../src/server/routes/github-app");
const migrate = githubAppRouter.stack.find(layer => layer.route?.path === "/connections/migrate").route.stack[0].handle;

for (const type of ["repository", "pull-request"]) {
  describe(`${type} App reinstall recovery`, function () {
    let restores, model, selected, writes, checks, owner;
    function stub(object, key, value) {
      const previous = object[key]; restores.push(() => { object[key] = previous; }); object[key] = value;
    }
    beforeEach(function () {
      restores = []; writes = []; checks = []; owner = "owner";
      model = { _id: "saved-resource", owner: "owner", status: "ready", statusDate: new Date(),
        repoId: "published-url", pullRequestId: "published-url",
        source: { repositoryName: "owner/private", repositoryFullName: "owner/private", commit: "saved-sha", pullRequestId: 7 },
        githubAccess: { kind: "github-app", repositoryId: 42, installationId: 100, revision: "old" },
      };
      selected = { token: "fresh-token", binding: { kind: "github-app", repositoryId: 42, installationId: 200, revision: "new" } };
      stub(config, "GITHUB_APP_ENABLED", true); stub(config, "GITHUB_APP_NEW_CONNECTIONS", true);
      stub(utils, "getUser", async () => ({ id: owner }));
      stub(utils, "handleError", error => { throw error; });
      stub(app, "selectRepositoryAccess", async (id, name, connection, repositoryId) => {
        expect(repositoryId).to.equal(42);
        expect([id, name, connection]).to.deep.equal(["owner", "owner/private", "github-app"]);
        return selected;
      });
      stub(app, "githubRequest", async (url, token) => { checks.push({ url, token }); return {}; });
      const Model = type === "repository" ? Repositories : PullRequests;
      stub(Model, "findOne", async filter => filter.owner === model.owner ? model : null);
      stub(Model, "updateOne", async (filter, update) => { writes.push({ filter, update }); return { modifiedCount: 1 }; });
    });
    afterEach(function () { while (restores.length) restores.pop()(); });
    async function run(preview = false) {
      let response;
      await migrate({ body: { type, id: "published-url", connection: "github-app", preview } }, { json: body => { response = body; } });
      return response;
    }
    async function fails(message) {
      let error; try { await run(); } catch (caught) { error = caught; }
      expect(error?.message).to.equal(message); expect(writes).to.have.length(0);
    }
    it("previews fresh installation access without changing the saved binding", async function () {
      expect(await run(true)).to.deep.equal({ eligible: true, connection: "github-app" });
      expect(writes).to.have.length(0); expect(model.githubAccess.installationId).to.equal(100);
    });
    it("replaces only the binding while preserving the URL, source and snapshot", async function () {
      expect(await run()).to.deep.equal({ connection: "github-app" });
      expect(writes).to.have.length(1);
      expect(writes[0].update).to.deep.equal({ $set: { githubAccess: selected.binding } });
      expect(writes[0].filter.githubAccess).to.deep.equal(model.githubAccess);
      expect(writes[0].filter.source).to.deep.equal(model.source);
      expect(checks).to.deep.equal([{ url: type === "repository" ? "/repos/owner/private/commits/saved-sha" : "/repos/owner/private/pulls/7", token: "fresh-token" }]);
    });
    it("saves a resolved rename atomically with the binding after preview", async function () {
      selected.fullName = "owner/renamed";
      await run(true);
      expect(writes).to.have.length(0);
      await run();
      expect(writes).to.have.length(1);
      expect(writes[0].update).to.deep.equal({ $set: {
        githubAccess: selected.binding,
        [type === "repository" ? "source.repositoryName" : "source.repositoryFullName"]: "owner/renamed",
      } });
      expect(writes[0].filter.source).to.deep.equal(model.source);
      expect(writes[0].filter.githubAccess).to.deep.equal(model.githubAccess);
      expect(checks.every(check => check.url.startsWith("/repos/owner/renamed/"))).to.equal(true);
    });
    it("rejects a replacement repository at the same name", async function () {
      selected.binding.repositoryId = 99; await fails("connection_changed"); expect(checks).to.have.length(0);
    });
    for (const status of ["preparing", "queue", "download", "removing", "expiring"]) {
      it("rejects reconnect during " + status, async function () {
        model.status = status;
        await fails("repository_busy");
        expect(checks).to.have.length(0);
      });
    }
    it("requires access to the existing snapshot before saving", async function () {
      stub(app, "githubRequest", async () => { throw new Error("github_app_access_required"); });
      await fails("github_app_access_required");
    });
    if (type === "pull-request") {
      it("allows stale downloads but guards their timestamp against a new refresh", async function () {
        model.status = "download";
        model.statusDate = new Date(Date.now() - 6 * 60 * 1000);
        await run();
        expect(writes[0].filter.statusDate).to.equal(model.statusDate);
      });
    }
    it("does not let another user repair the binding", async function () {
      owner = "other"; await fails("repo_not_found");
    });
    it("reports a concurrent change instead of overwriting it", async function () {
      stub(type === "repository" ? Repositories : PullRequests, "updateOne", async () => ({ modifiedCount: 0 }));
      await fails("connection_changed");
    });
  });
}
