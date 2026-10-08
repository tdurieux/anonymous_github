const { expect } = require("chai");
const process = require("node:process");
const mongoose = require("mongoose");
require("ts-node/register/transpile-only");
const db = require("../src/server/database");
const User = require("../src/core/User").default;
const UserModel = require("../src/core/model/users/users.model").default;
const Repo = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const PR = require("../src/core/model/anonymizedPullRequests/anonymizedPullRequests.model").default;
const Gist = require("../src/core/model/anonymizedGists/anonymizedGists.model").default;
const File = require("../src/core/model/files/files.model").default;
const Path = require("../src/core/model/anonymized-path").default;
const Name = require("../src/core/model/dashboard-name").default;
const Repository = require("../src/core/Repository").default;
const Conference = require("../src/core/Conference").default;
const ConferenceModel = require("../src/core/model/conference/conferences.model").default;
const AnonymizedFile = require("../src/core/AnonymizedFile").default;
const { dashboardSummary } = require("../src/server/routes/dashboard-summary");
const { projectNameKey } = require("../src/server/routes/project-names");
const uri = process.env.PERFORMANCE_MONGO_URI;

(uri ? describe : describe.skip)("disposable MongoDB performance integration", function () {
  this.timeout(60000);
  let user, folder, temporary;
  before(async () => {
    if (!/\/perf_test_[A-Za-z0-9_-]+(?:\?|$)/.test(uri)) throw Error("An isolated perf_test_ database is required");
    await mongoose.connect(uri);
    const fs = require("node:fs/promises"), path = require("node:path"), config = require("../src/config").default;
    folder = config.FOLDER;
    temporary = await fs.mkdtemp(path.join(require("node:os").tmpdir(), "performance-mongo-storage-"));
    config.FOLDER = temporary;
    db.isConnected = true;
    await Promise.all([Repo, PR, Gist, File, Path, Name].map(model => model.createIndexes()));
    user = new User(await UserModel.create({ username: "perf-owner", externalIDs: { github: "12345" } }));
  });
  after(async () => {
    db.isConnected = false; await mongoose.connection.dropDatabase(); await mongoose.disconnect();
    require("../src/config").default.FOLDER = folder;
    if (temporary) await require("node:fs/promises").rm(temporary, { force: true, recursive: true });
  });
  beforeEach(async () => { await Promise.all([Repo, PR, Gist, File, Path, Name, ConferenceModel].map(model => model.deleteMany({}))); });

  it("uses membership indexes for owner, stable GitHub ID, and legacy username", async () => {
    const other = new mongoose.Types.ObjectId();
    await Repo.insertMany(Array.from({ length: 2000 }, (_, i) => ({ repoId: `filler-${i}`, owner: other, coauthors: [{ username: `other-${i}`, githubId: String(i + 50000) }] })));
    await Repo.create({ repoId: "owned", owner: user.model._id });
    await Repo.create({ repoId: "coauthored", owner: other, coauthors: [{ username: "old-name", githubId: "12345" }] });
    await Repo.create({ repoId: "legacy", owner: other, coauthors: [{ username: user.username }] });
    for (const filter of user.repositoryMembership().$or) {
      const plan = await Repo.find(filter).explain("executionStats");
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.to.include("COLLSCAN");
      expect(plan.executionStats.totalDocsExamined).to.be.lessThan(10);
    }
    expect((await user.getRepositories()).map(repo => repo.repoId).sort()).to.deep.equal(["coauthored", "legacy", "owned"]);
  });

  it("uses indexes for repository, gist and PR maintenance over unrelated records", async () => {
    const { repositoryMaintenanceQuery, contentMaintenanceQuery } = require("../src/server/schedule");
    const now = new Date(), future = new Date(Date.now() + 86400000), old = new Date("2020-01-01");
    for (const [model, id] of [[Repo, "repoId"], [Gist, "gistId"], [PR, "pullRequestId"]]) {
      await model.insertMany(Array.from({ length: 2000 }, (_, i) => ({ [id]: `unrelated-${i}`, status: "ready",
        lastView: now, options: { expirationMode: "never", expirationDate: future } })));
      await model.create({ [id]: "due", status: "ready", lastView: now, options: { expirationMode: "remove", expirationDate: old } });
      await model.create({ [id]: "backlog", status: "expiring", lastView: now, options: { expirationMode: "remove", expirationDate: old } });
      const query = model === Repo ? repositoryMaintenanceQuery(now) : contentMaintenanceQuery(now);
      if (model === Repo) await model.create({ repoId: "unused", status: "ready", lastView: old, options: { expirationMode: "never", expirationDate: future } });
      const plan = await model.find(query).explain("executionStats");
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.to.include("COLLSCAN");
      expect(plan.executionStats.totalDocsExamined).to.be.lessThan(10);
      expect((await model.find(query)).map(row => row[id]).sort()).to.deep.equal(model === Repo ? ["due", "unused"] : ["backlog", "due"]);
    }
  });

  it("adds all maintenance indexes through the migration without dropping existing indexes", async () => {
    const { execFile } = require("node:child_process"), { promisify } = require("node:util");
    await Gist.collection.createIndex({ statusMessage: 1 }, { name: "keep_existing_index" });
    for (const model of [Repo, Gist, PR]) await model.collection.dropIndex("status_1_options.expirationDate_1");
    await Repo.collection.dropIndex("retiredTreeGenerations_1");
    await File.collection.dropIndex("metadataPending_1_repoId_1_treeGeneration_1");
    await Repo.collection.dropIndex("retiredContentPrefixes_1");
    await Repo.collection.dropIndex("legacyContentCleanupPending_1_status_1");
    await Repo.create({ repoId: "legacy-cache", source: { type: "GitHubStream" } });
    await Repo.create({ repoId: "zip-cache", source: { type: "Zip" } });
    for (let i = 0; i < 2; i++) await promisify(execFile)(process.execPath, ["-r", "ts-node/register", "src/scripts/create-performance-indexes.ts"], {
      cwd: require("node:path").join(__dirname, ".."), env: { ...process.env, NODE_ENV: "test", MONGODB_URI: uri }, timeout: 30000,
    });
    for (const model of [Repo, Gist, PR]) {
      expect((await model.collection.indexes()).map(index => index.name)).to.include("status_1_options.expirationDate_1");
    }
    expect((await Gist.collection.indexes()).map(index => index.name)).to.include("keep_existing_index");
    expect((await Repo.collection.indexes()).find(index => index.name === "retiredTreeGenerations_1").sparse).to.equal(true);
    expect((await File.collection.indexes()).find(index => index.name === "metadataPending_1_repoId_1_treeGeneration_1").partialFilterExpression).to.deep.equal({ metadataPending: true });
    expect((await Repo.collection.indexes()).find(index => index.name === "retiredContentPrefixes_1").sparse).to.equal(true);
    expect((await Repo.collection.indexes()).find(index => index.name === "legacyContentCleanupPending_1_status_1").partialFilterExpression).to.deep.equal({ legacyContentCleanupPending: true });
    expect((await Repo.findOne({ repoId: "legacy-cache" })).legacyContentCleanupPending).to.equal(true);
    expect((await Repo.findOne({ repoId: "zip-cache" })).legacyContentCleanupPending).to.equal(undefined);
  });

  for (const [model, Class, id, contentKey, content] of [
    [Gist, require("../src/core/Gist").default, "gistId", "gist", { description: "private", files: [{ filename: "private.txt", content: "secret" }] }],
    [PR, require("../src/core/PullRequest").default, "pullRequestId", "pullRequest", { title: "private", body: "secret", diff: "private diff", mergedDate: new Date() }],
  ]) {
    const create = (extra = {}) => model.create({ [id]: `expiry-${id}`, status: "ready", statusDate: new Date("2026-01-01"),
      anonymizeDate: new Date("2026-01-01"), options: { expirationMode: "remove", expirationDate: new Date(0) }, [contentKey]: content, ...extra });

    it(`atomically clears due and already-expiring ${contentKey} content`, async () => {
      for (const status of ["ready", "expiring"]) {
        const row = await create({ [id]: `due-${status}`, status });
        const instance = new Class(row);
        await instance.expire();
        const fresh = await model.findById(row._id);
        expect(fresh.status).to.equal("expired"); expect(instance.status).to.equal("expired");
        if (model === Gist) { expect(fresh.gist.files).to.have.length(0); expect(fresh.gist.description).to.equal(""); }
        else { expect(fresh.pullRequest.diff).to.equal(""); expect(fresh.pullRequest.body).to.equal(""); expect(fresh.pullRequest.mergedDate).to.equal(undefined); }
      }
    });

    it(`preserves ${contentKey} content after an expiration extension or mode change`, async () => {
      for (const [field, value] of [["options.expirationDate", new Date(Date.now() + 86400000)], ["options.expirationMode", "never"]]) {
        const row = await create({ [id]: field });
        const stale = new Class(row);
        await model.updateOne({ _id: row._id }, { $set: { [field]: value } });
        await stale.expire();
        const fresh = await model.findById(row._id);
        expect(fresh.status).to.equal("ready"); expect(JSON.stringify(fresh[contentKey])).to.equal(JSON.stringify(row[contentKey]));
        expect(fresh.get(field)).to.deep.equal(value);
      }
    });

    it(`rejects stale ${contentKey} cleanup after a rebuild or lifecycle transition`, async () => {
      for (const change of [{ anonymizeDate: new Date() }, { statusDate: new Date() }, { status: "download" }]) {
        const row = await create({ [id]: Object.keys(change)[0] });
        const stale = new Class(row);
        const field = model === Gist ? "gist.description" : "pullRequest.diff";
        await model.updateOne({ _id: row._id }, { $set: { ...change, [field]: "rebuilt content" } });
        await stale.expire();
        const fresh = await model.findById(row._id);
        expect(fresh.get(field)).to.equal("rebuilt content"); expect(fresh.status).to.equal(change.status || "ready");
      }
    });

    it(`does not clean a future or never-expiring ${contentKey}`, async () => {
      for (const options of [{ expirationMode: "remove", expirationDate: new Date(Date.now() + 86400000) }, { expirationMode: "never", expirationDate: new Date(0) }]) {
        const row = await create({ [id]: options.expirationMode, options });
        await new Class(row).expire();
        const fresh = await model.findById(row._id);
        expect(fresh.status).to.equal("ready"); expect(JSON.stringify(fresh[contentKey])).to.equal(JSON.stringify(row[contentKey]));
      }
    });
  }

  it("preserves PR content after its GitHub access revision changes", async () => {
    const row = await PR.create({ pullRequestId: "access-expiry", status: "ready", statusDate: new Date(), anonymizeDate: new Date(),
      githubAccess: { kind: "github-app", revision: "old" }, options: { expirationMode: "remove", expirationDate: new Date(0) }, pullRequest: { diff: "rebuilt diff" } });
    await PR.updateOne({ _id: row._id }, { $set: { "githubAccess.revision": "new" } });
    await new (require("../src/core/PullRequest").default)(row).expire();
    const fresh = await PR.findById(row._id);
    expect(fresh.status).to.equal("ready"); expect(fresh.pullRequest.diff).to.equal("rebuilt diff");
  });

  it("paginates a mixed dashboard globally and excludes megabyte bodies", async () => {
    const date = new Date("2026-01-01");
    await Repo.create({ repoId: "repo", owner: user.model._id, status: "ready", anonymizeDate: date, source: { repositoryName: "owner/repo", commit: "abcdef1234567890" }, options: { expirationMode: "never" } });
    await PR.create({ pullRequestId: "pr", owner: user.model._id, status: "error", anonymizeDate: date, source: { repositoryFullName: "owner/repo", pullRequestId: 1 }, pullRequest: { diff: "x".repeat(1024 * 1024), body: "y".repeat(1024 * 1024) } });
    await Gist.create({ gistId: "gist", owner: user.model._id, status: "ready", anonymizeDate: date, source: { gistId: "upstream" }, gist: { files: [{ filename: "private.txt", content: "z".repeat(1024 * 1024) }] } });
    user.model.projectNames = new Map([[projectNameKey("repo", "repo"), "A named package"]]);
    await Name.create({ owner: user.model._id, type: "repo", artifactId: "repo", name: "Interrupted old name" });
    const first = await dashboardSummary(user, { limit: 2 });
    const second = await dashboardSummary(user, { limit: 2, cursor: first.cursor });
    expect(first.total).to.equal(3); expect(first.attention).to.equal(1);
    expect(first.filtered).to.equal(3);
    const items = [...first.items, ...second.items];
    expect(new Set(items.map(item => item._type)).size).to.equal(3);
    expect(JSON.stringify(items).length).to.be.lessThan(10000);
    expect(items.find(item => item.repoId === "repo").projectName).to.equal("A named package");
    expect(items.find(item => item.repoId === "repo").source).to.deep.equal({ fullName: "owner/repo", commit: "abcdef1234567890" });
    const named = await dashboardSummary(user, { sort: "_label", q: "named" });
    expect(named.items.map(item => item.repoId)).to.deep.equal(["repo"]);
    const filtered = await dashboardSummary(user, { type: "pr", statuses: "error" });
    expect(filtered.items).to.have.length(1); expect(filtered.filtered).to.equal(1); expect(filtered.total).to.equal(3);
    const hidden = await dashboardSummary(user, { q: "private.txt" });
    expect(hidden.items).to.have.length(0);
    user.model.projectNames = undefined;
  });

  it("builds separate path generations and uses exact indexed lookups", async () => {
    const model = await Repo.create({ repoId: "paths", owner: user.model._id, status: "ready", treeGeneration: "tree1", anonymizeDate: new Date(),
      source: { type: "GitHubStream", commit: "commit1", repositoryName: "owner/repo" }, options: { terms: ["secret=>hidden"] } });
    await File.insertMany(Array.from({ length: 1000 }, (_, i) => ({ repoId: "paths", treeGeneration: "tree1", path: `secret/folder${i}`, name: "file.ts", sha: "a".repeat(40), size: i })));
    const repo = new Repository(model);
    expect((await new AnonymizedFile({ repository: repo, anonymizedPath: "hidden/folder999/file.ts" }).getFileInfo()).path).to.equal("secret/folder999");
    const key = repo.model.pathIndexKey;
    const plan = await Path.find({ repoId: "paths", key, anonymousPath: "hidden/folder999/file.ts" }).explain("executionStats");
    expect(plan.executionStats.totalDocsExamined).to.equal(1);
    expect(await repo.searchFiles("hidden")).to.have.length(500);
    repo.model.options.terms = ["secret=>public"];
    await Repo.updateOne({ _id: model._id }, { $set: { "options.terms": repo.options.terms } });
    const renamed = await repo.findAnonymizedPath("public/folder999/file.ts");
    expect(renamed.path).to.equal("secret/folder999");
    expect(repo.model.pathIndexKey).not.to.equal(key);
    expect(await repo.findAnonymizedPath("hidden/folder999/file.ts")).to.equal(null);
  });

  for (const action of ["resetSate", "remove", "expire"]) {
    it(`deletes all derived private paths during ${action}`, async () => {
      const row = await Repo.create({ repoId: "private-paths", owner: user.model._id, status: "ready", statusDate: new Date(),
        treeGeneration: "tree", anonymizeDate: new Date(), source: { type: "GitHubStream", repositoryName: "owner/repo" }, options: { terms: ["private=>hidden"], expirationMode: "remove", expirationDate: new Date(0) } });
      await File.create({ repoId: row.repoId, treeGeneration: "tree", path: "private", name: "secret.txt", sha: "a".repeat(40), size: 1 });
      const repo = new Repository(row);
      await repo.findAnonymizedPath("hidden/secret.txt");
      await Path.create({ repoId: row.repoId, key: "old-generation", name: "older.txt", path: "private", sha: "b".repeat(40) });
      await Path.create({ repoId: "other-repository", key: "keep", name: "kept.txt", path: "public" });
      const storage = require("../src/core/storage").default, rm = storage.rm;
      storage.rm = async () => {};
      try { await repo[action](); } finally { storage.rm = rm; }
      expect(await Path.countDocuments({ repoId: row.repoId })).to.equal(0);
      expect(await File.countDocuments({ repoId: row.repoId })).to.equal(0);
      expect(await Path.countDocuments({ repoId: "other-repository" })).to.equal(1);
      expect((await Repo.findById(row._id)).pathIndexKey).to.equal(undefined);
    });
  }

  for (const action of ["resetSate", "expire"]) {
    it(`cleans a derived path builder that finishes after ${action}`, async () => {
      const row = await Repo.create({ repoId: "reset-builder", owner: user.model._id, status: "ready", statusDate: new Date(),
        treeGeneration: "tree", anonymizeDate: new Date(), source: { type: "GitHubStream", repositoryName: "owner/repo" }, options: { terms: [], expirationMode: "remove", expirationDate: new Date(0) } });
      await File.create({ repoId: row.repoId, treeGeneration: "tree", path: "private", name: "secret.txt", sha: "a".repeat(40), size: 1 });
      const bulkWrite = Path.bulkWrite, storage = require("../src/core/storage").default, rm = storage.rm;
      let started, release;
      const began = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
      Path.bulkWrite = async function (...args) { started(); await held; return bulkWrite.apply(this, args); };
      storage.rm = async () => {};
      const building = new Repository(row).findAnonymizedPath("private/secret.txt");
      try {
        await Promise.race([began, building.then(() => { throw Error("builder did not pause"); })]);
        await new Repository(await Repo.findById(row._id))[action]();
        if (action === "expire") {
          try { await new Repository(await Repo.findById(row._id)).findAnonymizedPath("private/secret.txt"); throw Error("expected expiration rejection"); }
          catch (error) { expect(error.message).to.equal("repository_changed"); }
        }
        release();
        try { await building; throw Error("expected stale builder rejection"); }
        catch (error) { expect(error.message).to.equal("repository_changed"); }
        expect(await Path.countDocuments({ repoId: row.repoId })).to.equal(0);
        expect((await Repo.findById(row._id)).pathIndexKey).to.equal(undefined);
      } finally { release(); await building.catch(() => {}); Path.bulkWrite = bulkWrite; storage.rm = rm; }
    });
  }

  it("keeps exact paths ahead of anonymization collisions and resolves other collisions consistently", async () => {
    const repo = new Repository(await Repo.create({ repoId: "collision", owner: user.model._id, status: "ready", treeGeneration: "tree", anonymizeDate: new Date(),
      source: { type: "GitHubStream", repositoryName: "owner/repo" }, options: { terms: ["alpha=>masked", "beta=>masked"] } }));
    await File.insertMany(["beta", "alpha", "masked"].map(name => ({ repoId: "collision", treeGeneration: "tree", path: "", name, sha: "a".repeat(40), size: 1 })));
    expect((await new AnonymizedFile({ repository: repo, anonymizedPath: "masked" }).getFileInfo()).name).to.equal("masked");
    await File.deleteOne({ repoId: "collision", name: "masked" });
    expect((await new AnonymizedFile({ repository: repo, anonymizedPath: "masked" }).getFileInfo()).name).to.equal("alpha");
  });

  it("preserves JavaScript Unicode case folding in database search", async () => {
    const repo = new Repository(await Repo.create({ repoId: "unicode-search", owner: user.model._id, status: "ready", treeGeneration: "tree", anonymizeDate: new Date(),
      source: { type: "GitHubStream", repositoryName: "owner/repo" }, options: { terms: [] } }));
    const rows = ["ΟΣ", "Σ", "ſ", "s", "K", "K", "İ", "i"].map(name => ({ repoId: repo.repoId, treeGeneration: "tree", name, path: "", size: 1, sha: "a".repeat(40) }));
    await File.insertMany(rows);
    for (const q of ["σ", "ς", "Σ", "ſ", "s", "k", "K", "i", "İ"]) {
      const expected = rows.filter(row => row.name.toLowerCase().includes(q.toLowerCase())).map(row => row.name).sort();
      expect((await repo.searchFiles(q)).map(row => row.name).sort(), q).to.deep.equal(expected);
    }
  });

  it("quota selects only owned, ready, unexpired repositories including cached zero", async () => {
    await Repo.insertMany([
      { repoId: "empty", owner: user.model._id, status: "ready", size: { file: 0, storage: 0 }, options: { expirationMode: "never" } },
      { repoId: "expired", owner: user.model._id, status: "ready", options: { expirationMode: "remove", expirationDate: new Date(0) } },
      { repoId: "coauthor", owner: new mongoose.Types.ObjectId(), status: "ready", coauthors: [{ githubId: "12345" }] },
    ]);
    const rows = await user.quotaRepositories();
    expect(rows.map(row => row.repoId)).to.deep.equal(["empty"]);
    expect(rows[0].size).to.deep.equal({ file: 0, storage: 0 });
    expect(rows[0]).not.to.have.property("options");
  });

  it("counts only the active tree and does not consider staged files ready", async () => {
    const model = await Repo.create({ repoId: "tree-counts", owner: user.model._id, status: "ready", treeGeneration: "active", options: { terms: [] } });
    await File.insertMany([
      { repoId: model.repoId, treeGeneration: "active", path: "src", name: "active.txt", size: 1 },
      { repoId: model.repoId, treeGeneration: "staged", path: "private", name: "staged.txt", size: 1 },
    ]);
    const repo = new Repository(model), utils = require("../src/server/routes/route-utils"), getRepo = utils.getRepo;
    const router = require("../src/server/routes/repository-public").default;
    const handler = router.stack.find(layer => layer.route?.path === "/:repoId/files/counts").route.stack.at(-1).handle;
    utils.getRepo = async () => repo;
    try {
      let response;
      await handler({ params: { repoId: model.repoId } }, { header() {}, json: data => { response = data; } });
      expect(response).to.deep.equal({ "": 1, src: 1 });
      await File.deleteMany({ repoId: model.repoId, treeGeneration: "active" });
      let refreshed = false;
      repo.updateIfNeeded = async ({ force }) => { refreshed = force; };
      expect(await repo.isReady()).to.equal(false); expect(refreshed).to.equal(true);
    } finally { utils.getRepo = getRepo; }
  });
  for (const [name, change] of [
    ["an expiration extension", { "options.expirationDate": new Date(Date.now() + 86400000) }],
    ["never-expiring settings", { "options.expirationMode": "never" }],
    ["a settings revision", { settingsSavedAt: new Date() }],
  ]) {
    it(`preserves repository content after ${name} changes before cleanup is claimed`, async () => {
      const row = await Repo.create({ repoId: "expiration-race", owner: user.model._id, status: "ready", statusDate: new Date(),
        anonymizeDate: new Date(), treeGeneration: "tree", source: { type: "GitHubStream", repositoryName: "owner/repo" },
        options: { terms: [], expirationMode: "remove", expirationDate: new Date(0) } });
      await File.create({ repoId: row.repoId, treeGeneration: "tree", path: "private", name: "secret.txt", sha: "a".repeat(40), size: 1 });
      const stale = new Repository(row);
      await stale.findAnonymizedPath("private/secret.txt");
      const paths = await Path.countDocuments({ repoId: row.repoId });
      await Repo.updateOne({ _id: row._id }, { $set: change });
      const storage = require("../src/core/storage").default, rm = storage.rm;
      storage.rm = async () => { throw Error("stale storage deletion"); };
      try { await stale.expire(); } finally { storage.rm = rm; }
      const fresh = await Repo.findById(row._id).select("+cleanupToken");
      expect(fresh.status).to.equal("ready"); expect(fresh.cleanupToken).to.equal(undefined);
      expect(await File.countDocuments({ repoId: row.repoId })).to.equal(1);
      expect(await Path.countDocuments({ repoId: row.repoId })).to.equal(paths);
      expect(fresh.pathIndexKey).to.equal(stale.model.pathIndexKey);
      for (const [field, value] of Object.entries(change)) expect(fresh.get(field)).to.deep.equal(value);
    });
  }

  it("rejects a stale settings save after repository cleanup claims the lifecycle", async () => {
    const row = await Repo.create({ repoId: "settings-cleanup-race", owner: user.model._id, status: "ready", statusDate: new Date(),
      anonymizeDate: new Date(), treeGeneration: "tree", source: { type: "GitHubStream", repositoryName: "owner/repo", branch: "main", commit: "abc123" },
      options: { terms: [], expirationMode: "remove", expirationDate: new Date(0) } });
    const stale = new Repository(row);
    const utils = require("../src/server/routes/route-utils"), storage = require("../src/core/storage").default;
    const original = { getRepo: utils.getRepo, getUser: utils.getUser, handleError: utils.handleError, rm: storage.rm };
    utils.getRepo = async () => stale;
    utils.getUser = async () => {
      await new Repository(await Repo.findById(row._id)).expire();
      return { isAdmin: true };
    };
    utils.handleError = error => { throw error; };
    storage.rm = async () => {};
    const router = require("../src/server/routes/repository-private").default;
    const handler = router.stack.find(layer => layer.route?.path === "/:repoId/" && layer.route.methods.post).route.stack[0].handle;
    try {
      try {
        await handler({ body: { repoId: row.repoId, fullName: "owner/repo", source: { branch: "main", commit: "abc123" }, terms: [],
          options: { expirationMode: "remove", expirationDate: new Date(Date.now() + 86400000).toISOString() } } }, {});
        throw Error("expected settings conflict");
      } catch (error) { expect(error.message).to.equal("connection_changed"); expect(error.httpStatus).to.equal(409); }
      const fresh = await Repo.findById(row._id);
      expect(fresh.status).to.equal("expired"); expect(fresh.options.expirationDate.getTime()).to.equal(0);
      expect(fresh.settingsSavedAt).to.equal(undefined);
    } finally { utils.getRepo = original.getRepo; utils.getUser = original.getUser; utils.handleError = original.handleError; storage.rm = original.rm; }
  });

  it("does not claim a future or never-expiring ready repository", async () => {
    const storage = require("../src/core/storage").default, rm = storage.rm;
    storage.rm = async () => { throw Error("unexpected storage deletion"); };
    try {
      for (const options of [{ expirationMode: "remove", expirationDate: new Date(Date.now() + 86400000) }, { expirationMode: "never", expirationDate: new Date(0) }]) {
        const row = await Repo.create({ repoId: `not-due-${options.expirationMode}`, status: "ready", statusDate: new Date(), options });
        await new Repository(row).expire();
        expect((await Repo.findById(row._id)).status).to.equal("ready");
      }
    } finally { storage.rm = rm; }
  });

  it("claims expiration once and deletes every file generation", async () => {
    const storage = require("../src/core/storage").default;
    const originalRm = storage.rm;
    let release, started, calls = 0;
    const began = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const model = await Repo.create({ repoId: "cleanup", owner: user.model._id, status: "expiring", statusDate: new Date(),
      anonymizeDate: new Date(), treeGeneration: "old", source: { type: "GitHubStream", repositoryName: "owner/repo" } });
    await File.insertMany(["old", "new"].map(treeGeneration => ({ repoId: "cleanup", treeGeneration, path: "", name: "file.txt", size: 1 })));
    storage.rm = async () => { calls++; started(); await held; };
    try {
      const first = new Repository(model).expire();
      await began;
      await new Repository(await Repo.findById(model._id)).expire();
      expect(calls).to.equal(1);
      release(); await first;
      expect(await File.countDocuments({ repoId: "cleanup", treeGeneration: "old" })).to.equal(0);
      expect(await File.countDocuments({ repoId: "cleanup" })).to.equal(0);
      expect((await Repo.findById(model._id)).status).to.equal("expired");
    } finally { release(); storage.rm = originalRm; }
  });

  it("rejects stale cleanup after restoration before touching storage", async () => {
    const storage = require("../src/core/storage").default;
    const originalRm = storage.rm;
    const model = await Repo.create({ repoId: "restore", owner: user.model._id, status: "expiring", statusDate: new Date(),
      anonymizeDate: new Date(), treeGeneration: "old", source: { type: "GitHubStream", repositoryName: "owner/repo" } });
    const stale = new Repository(model);
    await Repo.updateOne({ _id: model._id }, { $set: { status: "ready", statusDate: new Date(Date.now() + 1), treeGeneration: "new", anonymizeDate: new Date(Date.now() + 1) } });
    storage.rm = async () => { throw Error("stale deletion"); };
    try { await stale.expire(); expect((await Repo.findById(model._id)).status).to.equal("ready"); }
    finally { storage.rm = originalRm; }
  });

  it("stops metadata cleanup when the claimed lifecycle changes during storage removal", async () => {
    const storage = require("../src/core/storage").default, rm = storage.rm;
    const model = await Repo.create({ repoId: "changed-claim", status: "expiring", statusDate: new Date(), treeGeneration: "old" });
    storage.rm = async () => {
      await Repo.updateOne({ _id: model._id }, { $set: { status: "ready", treeGeneration: "new", fileMetadataRevision: "new" } });
      await File.create({ repoId: model.repoId, treeGeneration: "new", path: "", name: "restored.txt", size: 1 });
      await Path.collection.insertOne({ repoId: model.repoId, key: "new", anonymousPath: "restored.txt" });
    };
    try {
      await new Repository(model).expire();
      expect((await Repo.findById(model._id)).status).to.equal("ready");
      expect(await File.countDocuments({ repoId: model.repoId })).to.equal(1);
      expect(await Path.countDocuments({ repoId: model.repoId })).to.equal(1);
    } finally { storage.rm = rm; }
  });

  for (const [sourceType, generation] of [["Zip", "tree"], ["GitHubStream", undefined]]) {
    it(`removes the complete ${sourceType} storage root including private empty directories`, async () => {
      const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
      const config = require("../src/config").default, folder = config.FOLDER;
      const storage = require("../src/core/storage").default, rm = storage.rm;
      const backend = new (require("../src/core/storage/FileSystem").default)();
      const { FILE_TYPE } = require("../src/core/storage/Storage");
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "expire-root-"));
      config.FOLDER = temporary;
      const calls = [];
      storage.rm = async (...args) => { calls.push(args); await backend.rm(...args); };
      try {
        const model = await Repo.create({ repoId: "private-archive", status: "expiring", statusDate: new Date(),
          treeGeneration: generation, source: { type: sourceType } });
        await backend.mk(model.repoId, "private/empty");
        await backend.write(model.repoId, "private/nested/secret.txt", "secret");
        await backend.write("unrelated", "keep.txt", "keep");
        await File.insertMany([
          { repoId: model.repoId, treeGeneration: generation, path: "private", name: "empty", size: null },
          { repoId: model.repoId, treeGeneration: generation, path: "private/nested", name: "secret.txt", size: 6 },
          { repoId: model.repoId, treeGeneration: "retired", path: "", name: "old.txt", size: 1 },
          { repoId: "unrelated", name: "keep.txt", path: "", size: 4 },
        ]);
        await new Repository(model).expire();
        expect(calls).to.deep.equal([[model.repoId]]);
        expect(await backend.exists(model.repoId)).to.equal(FILE_TYPE.NOT_FOUND);
        expect(await backend.exists("unrelated", "keep.txt")).to.equal(FILE_TYPE.FILE);
        expect(await File.countDocuments({ repoId: model.repoId })).to.equal(0);
        expect(await File.countDocuments({ repoId: "unrelated" })).to.equal(1);
        expect((await Repo.findById(model._id)).status).to.equal("expired");
      } finally { storage.rm = rm; config.FOLDER = folder; await fs.rm(temporary, { recursive: true, force: true }); }
    });
  }

  it("expires conference repositories in every active status and drains their cleanup backlog", async () => {
    const statuses = ["ready", "error", "preparing", "queue", "download"];
    const models = await Repo.insertMany(statuses.map(status => ({ repoId: `conference-${status}`, owner: user.model._id,
      status, statusDate: new Date(), treeGeneration: "tree", source: { type: "GitHubStream" }, options: { expirationMode: "never" } })));
    await File.insertMany(models.map(model => ({ repoId: model.repoId, treeGeneration: "tree", path: "", name: "cached.txt", size: 1 })));
    const conference = new Conference(await ConferenceModel.create({ conferenceID: "expired", status: "ready",
      endDate: new Date(0), repositories: models.map(model => ({ id: model._id })) }));
    await conference.expire();
    expect(conference.status).to.equal("expired");
    for (const model of await Repo.find({})) {
      expect(model.status).to.equal("expiring");
      try { await new Repository(model).check(); throw Error("expected expiration"); }
      catch (error) { expect(error.message).to.equal("repository_expired"); }
    }
    const storage = require("../src/core/storage").default, rm = storage.rm;
    const cleaned = [];
    storage.rm = async repoId => { cleaned.push(repoId); };
    try { await require("../src/server/schedule").runRepositoryStatusCheck(); }
    finally { storage.rm = rm; }
    expect(cleaned.sort()).to.deep.equal(models.map(model => model.repoId).sort());
    expect(await Repo.countDocuments({ status: "expired" })).to.equal(statuses.length);
    expect(await File.countDocuments({})).to.equal(0);
  });

  it("does not overwrite terminal states or an existing cleanup claim on forced expiration", async () => {
    const date = new Date("2026-01-01");
    for (const status of ["archived", "removed", "removing", "expired", "expiring"]) {
      const model = await Repo.create({ repoId: `inactive-${status}`, status, statusDate: date,
        cleanupToken: "active-claim", cleanupUntil: new Date(Date.now() + 60000) });
      await new Repository(model).markExpired(true);
      const fresh = await Repo.findById(model._id).select("+cleanupToken");
      expect(fresh.status).to.equal(status); expect(fresh.statusDate.getTime()).to.equal(date.getTime());
      expect(fresh.cleanupToken).to.equal("active-claim");
    }
    const model = await Repo.create({ repoId: "concurrent-removal", status: "ready", statusDate: date });
    const stale = new Repository(model);
    await Repo.updateOne({ _id: model._id }, { $set: { status: "removing" } });
    await stale.markExpired(true);
    expect((await Repo.findById(model._id)).status).to.equal("removing");
  });

  it("persists an empty tree across listing, search and readiness checks, and invalidates it on replacement", async () => {
    const model = await Repo.create({ repoId: "empty-tree", owner: user.model._id, status: "ready", statusDate: new Date(),
      source: { type: "GitHubStream" }, options: { terms: [] } });
    const repo = new Repository(model);
    let fetches = 0, files = [];
    const source = { getFiles: async () => { fetches++; return files; } };
    Object.defineProperty(repo, "source", { get: () => source });
    expect(await repo.files()).to.have.length(0);
    const generation = repo.model.treeGeneration;
    const fresh = new Repository(await Repo.findById(model._id));
    Object.defineProperty(fresh, "source", { get: () => source });
    fresh.updateIfNeeded = async () => { throw Error("unexpected refresh"); };
    expect(await fresh.files()).to.have.length(0);
    expect(await fresh.searchFiles("anything")).to.have.length(0);
    expect(await fresh.isReady()).to.equal(true);
    expect(fresh.model.treeGeneration).to.equal(generation); expect(fetches).to.equal(1);
    files = [{ path: "", name: "new.txt", size: 1 }];
    expect(await fresh.files({ force: true })).to.have.length(1);
    expect(fresh.model.emptyTreeGeneration).to.equal(undefined);
    expect((await Repo.findById(model._id)).emptyTreeGeneration).to.equal(undefined);
    await File.deleteMany({ repoId: model.repoId });
    let refreshed = false;
    fresh.updateIfNeeded = async () => { refreshed = true; };
    expect(await fresh.isReady()).to.equal(false); expect(refreshed).to.equal(true);
  });

  it("does not accept an empty-tree marker from a different generation", async () => {
    const repo = new Repository(await Repo.create({ repoId: "stale-empty", status: "ready", statusDate: new Date(),
      treeGeneration: "new", emptyTreeGeneration: "old", source: { type: "GitHubStream" } }));
    let fetched = 0;
    Object.defineProperty(repo, "source", { get: () => ({ getFiles: async () => { fetched++; return []; } }) });
    expect(await repo.files()).to.have.length(0); expect(fetched).to.equal(1);
    expect(repo.model.emptyTreeGeneration).to.equal(repo.model.treeGeneration);
  });

  it("keeps the active file tree when fetching its replacement fails", async () => {
    const model = await Repo.create({ repoId: "tree-refresh", owner: user.model._id, status: "ready", statusDate: new Date(),
      treeGeneration: "old", source: { type: "GitHubStream", repositoryName: "owner/repo" } });
    await File.create({ repoId: model.repoId, treeGeneration: "old", path: "", name: "kept.txt", size: 1 });
    const repo = new Repository(model);
    Object.defineProperty(repo, "source", { get: () => ({ getFiles: async () => { throw Error("GitHub unavailable"); } }) });
    await repo.files({ force: true }).catch(() => {});
    expect(await File.countDocuments({ repoId: model.repoId, treeGeneration: "old" })).to.equal(1);
    expect((await Repo.findById(model._id)).treeGeneration).to.equal("old");
  });

  it("recomputes a cached quota when activating a replacement tree", async () => {
    const model = await Repo.create({ repoId: "replace-size", owner: user.model._id, status: "ready", statusDate: new Date(),
      treeGeneration: "old", size: { storage: 900, file: 1 }, sizeComputedAt: new Date(), source: { type: "GitHubStream", repositoryName: "owner/repo" } });
    await File.create({ repoId: model.repoId, treeGeneration: "old", path: "", name: "old.txt", size: 900 });
    const repo = new Repository(model);
    Object.defineProperty(repo, "source", { get: () => ({ getFiles: async () => [
      { path: "", name: "one.txt", size: 2 }, { path: "", name: "two.txt", size: 3 },
    ] }) });
    expect(await repo.files({ force: true })).to.have.length(2);
    expect((await Repo.findById(model._id).lean()).size).to.deep.equal({ storage: 5, file: 2 });
    expect(await File.countDocuments({ repoId: model.repoId, treeGeneration: "old" })).to.equal(0);
  });

  for (const previousGeneration of ["old", undefined]) {
    it(`retries interrupted retirement of ${previousGeneration || "legacy"} tree rows during maintenance`, async () => {
      const model = await Repo.create({ repoId: "retire-tree", status: "ready", statusDate: new Date(), lastView: new Date(),
        treeGeneration: previousGeneration, source: { type: "GitHubStream" }, options: { expirationMode: "never" } });
      await File.create({ repoId: model.repoId, treeGeneration: previousGeneration, path: "private", name: "old.txt", size: 1 });
      await File.create({ repoId: "unrelated", treeGeneration: previousGeneration, path: "", name: "keep.txt", size: 1 });
      const repo = new Repository(model), deleteMany = File.deleteMany;
      Object.defineProperty(repo, "source", { get: () => ({ getFiles: async () => [{ path: "", name: "active.txt", size: 2 }] }) });
      File.deleteMany = function (filter, ...args) {
        if (filter.repoId === model.repoId && filter.$or) return { exec: async () => { throw Error("cleanup unavailable"); } };
        return deleteMany.call(this, filter, ...args);
      };
      try {
        expect(await repo.files({ force: true })).to.have.length(1);
        const activated = await Repo.findById(model._id);
        expect(activated.retiredTreeGenerations).to.deep.equal([previousGeneration || ""]);
        expect(activated.treeGeneration).not.to.equal(previousGeneration);
        await require("../src/server/schedule").runRepositoryStatusCheck();
        expect((await Repo.findById(model._id)).retiredTreeGenerations).to.have.length(1);
        expect(await File.countDocuments({ repoId: model.repoId })).to.equal(2);
      } finally { File.deleteMany = deleteMany; }
      await require("../src/server/schedule").runRepositoryStatusCheck();
      expect((await Repo.findById(model._id)).retiredTreeGenerations).to.equal(undefined);
      expect((await File.find({ repoId: model.repoId })).map(file => file.name)).to.deep.equal(["active.txt"]);
      expect(await File.countDocuments({ repoId: "unrelated" })).to.equal(1);
    });
  }

  it("uses indexes to find interrupted tree cleanup and recovered-file invalidations", async () => {
    await Repo.insertMany(Array.from({ length: 2000 }, (_, i) => ({ repoId: `clean-${i}` })));
    await File.insertMany(Array.from({ length: 2000 }, (_, i) => ({ repoId: `clean-${i}`, path: "", name: "file.txt" })));
    await Repo.create({ repoId: "retired", treeGeneration: "active", retiredTreeGenerations: ["old"] });
    await Repo.create({ repoId: "retired-content", retiredContentPrefixes: ["__content/old"] });
    await Repo.create({ repoId: "legacy-content", legacyContentCleanupPending: true, status: "ready" });
    await File.create({ repoId: "pending", path: "", name: "pending.txt", metadataPending: true });
    for (const [model, query] of [[Repo, { $or: [
      { retiredTreeGenerations: { $exists: true } }, { retiredContentPrefixes: { $exists: true } },
      { legacyContentCleanupPending: true, status: "ready" },
    ] }], [File, { metadataPending: true }]]) {
      const plan = await model.find(query).explain("executionStats");
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.to.include("COLLSCAN");
      expect(plan.executionStats.totalDocsExamined).to.be.lessThan(10);
    }
  });

  it("durably retries retired content cleanup while preserving the active cache and other repositories", async () => {
    const backend = new (require("../src/core/storage/FileSystem").default)();
    const storage = require("../src/core/storage").default, rm = storage.rm;
    const { contentGenerationPrefix } = require("../src/core/content-generation");
    const date = new Date("2026-01-01"), oldPrefix = contentGenerationPrefix(`old:${date.toISOString()}`);
    const model = await Repo.create({ repoId: "retire-content", status: "ready", statusDate: date, lastView: new Date(),
      anonymizeDate: date, treeGeneration: "old", contentCacheVersion: 1, source: { type: "GitHubStream" }, options: { expirationMode: "never" } });
    await File.create({ repoId: model.repoId, treeGeneration: "old", path: "", name: "old.txt", size: 1 });
    await backend.write(model.repoId, `${oldPrefix}/blob/private/old.txt`, "obsolete");
    await backend.write("unrelated-content", `${oldPrefix}/blob/keep.txt`, "keep");
    const repo = new Repository(model);
    Object.defineProperty(repo, "source", { get: () => ({ getFiles: async () => [{ path: "", name: "active.txt", size: 1 }] }) });
    storage.rm = async () => { throw Error("storage unavailable"); };
    try {
      await repo.files({ force: true });
      expect((await Repo.findById(model._id)).retiredContentPrefixes).to.deep.equal([oldPrefix]);
      expect(await File.countDocuments({ repoId: model.repoId, treeGeneration: "old" })).to.equal(1);
    } finally { storage.rm = rm; }
    const activePrefix = contentGenerationPrefix(`${repo.model.treeGeneration}:${date.toISOString()}`);
    await backend.write(model.repoId, `${activePrefix}/blob/active.txt`, "active");
    await require("../src/server/schedule").runRepositoryStatusCheck();
    expect(await backend.exists(model.repoId, oldPrefix)).to.equal("not_found");
    expect(await backend.exists(model.repoId, `${activePrefix}/blob/active.txt`)).to.equal("file");
    expect(await backend.exists("unrelated-content", `${oldPrefix}/blob/keep.txt`)).to.equal("file");
    expect((await Repo.findById(model._id)).retiredContentPrefixes).to.equal(undefined);
    expect(await File.countDocuments({ repoId: model.repoId, treeGeneration: "old" })).to.equal(0);
  });

  it("retries legacy root cleanup, preserves versioned content, and leaves ZIP sources intact", async () => {
    const backend = new (require("../src/core/storage/FileSystem").default)();
    const storage = require("../src/core/storage").default, remove = storage.removeLegacyContent;
    const model = await Repo.create({ repoId: "legacy-root", status: "ready", statusDate: new Date(), lastView: new Date(),
      legacyContentCleanupPending: true, contentCacheVersion: 1, source: { type: "GitHubStream" }, options: { expirationMode: "never" } });
    const zip = await Repo.create({ repoId: "zip-root", status: "ready", lastView: new Date(), legacyContentCleanupPending: true,
      source: { type: "Zip" }, options: { expirationMode: "never" } });
    await backend.write(model.repoId, "private/legacy.txt", "obsolete");
    await backend.mk(model.repoId, "private/empty");
    const active = require("../src/core/content-generation").contentGenerationPrefix("active");
    await backend.write(model.repoId, `${active}/keep.txt`, "active");
    await backend.write(model.repoId, "__content/private/legacy.txt", "obsolete");
    await backend.write(zip.repoId, "private/source.txt", "keep");
    storage.removeLegacyContent = async () => { throw Error("legacy cleanup unavailable"); };
    try {
      await require("../src/server/schedule").runRepositoryStatusCheck();
      expect((await Repo.findById(model._id)).legacyContentCleanupPending).to.equal(true);
    } finally { storage.removeLegacyContent = remove; }
    await require("../src/server/schedule").runRepositoryStatusCheck();
    expect((await Repo.findById(model._id)).legacyContentCleanupPending).to.equal(undefined);
    expect(await backend.exists(model.repoId, "private")).to.equal("not_found");
    expect(await backend.exists(model.repoId, `${active}/keep.txt`)).to.equal("file");
    expect(await backend.exists(model.repoId, "__content/private")).to.equal("not_found");
    expect(await backend.exists(zip.repoId, "private/source.txt")).to.equal("file");
  });

  it("cannot retire a newer tree activated while an older builder finishes", async () => {
    const model = await Repo.create({ repoId: "overlapping-trees", owner: user.model._id, status: "ready", statusDate: new Date(),
      treeGeneration: "old", source: { type: "GitHubStream", repositoryName: "owner/repo" } });
    await File.create({ repoId: model.repoId, treeGeneration: "old", name: "old.txt", path: "", size: 1 });
    const repo = new Repository(model), updateOne = Repo.updateOne;
    Object.defineProperty(repo, "source", { get: () => ({ getFiles: async () => [{ name: "first.txt", path: "", size: 2 }] }) });
    let injected = false;
    Repo.updateOne = function (filter, update, ...args) {
      const query = updateOne.call(this, filter, update, ...args), exec = query.exec;
      if (update.$set?.treeGeneration && !injected) query.exec = async function () {
        const result = await exec.call(this); injected = true;
        await File.create({ repoId: model.repoId, treeGeneration: "newer", name: "latest.txt", path: "", size: 3 });
        await updateOne.call(Repo, { _id: model._id }, { $set: { treeGeneration: "newer", size: { storage: 3, file: 1 } } }).exec();
        return result;
      };
      return query;
    };
    try {
      await repo.files({ force: true });
      expect(await File.countDocuments({ repoId: model.repoId, treeGeneration: "newer" })).to.equal(1);
      expect((await Repo.findById(model._id).lean()).size).to.deep.equal({ storage: 3, file: 1 });
    } finally { Repo.updateOne = updateOne; }
  });

  it("cannot delete a newer path mapping while an older builder finishes", async () => {
    const model = await Repo.create({ repoId: "overlapping-paths", owner: user.model._id, status: "ready", treeGeneration: "tree", anonymizeDate: new Date(),
      source: { type: "GitHubStream", repositoryName: "owner/repo" }, options: { terms: ["secret=>old"] } });
    await File.create({ repoId: model.repoId, treeGeneration: "tree", name: "secret.txt", path: "", size: 1, sha: "a".repeat(40) });
    const repo = new Repository(model), updateOne = Repo.updateOne;
    Repo.updateOne = function (filter, update, ...args) {
      const query = updateOne.call(this, filter, update, ...args), exec = query.exec;
      if (update.$set?.pathIndexKey) query.exec = async function () {
        const result = await exec.call(this);
        await Path.collection.insertOne({ repoId: model.repoId, key: "newer", anonymousPath: "new.txt", path: "", name: "secret.txt" });
        await updateOne.call(Repo, { _id: model._id }, { $set: { pathIndexKey: "newer" } }).exec();
        return result;
      };
      return query;
    };
    try { await repo.findAnonymizedPath("old.txt"); expect(await Path.countDocuments({ repoId: model.repoId, key: "newer" })).to.equal(1); }
    finally { Repo.updateOne = updateOne; }
  });

  it("invalidates persisted path and quota caches after truncated-file recovery", async () => {
    const model = await Repo.create({ repoId: "recover-path", owner: user.model._id, status: "ready", statusDate: new Date(),
      treeGeneration: "tree", truncatedFolders: ["deep"], anonymizeDate: new Date(), source: { type: "GitHubStream", repositoryName: "owner/repo" } });
    await File.create({ repoId: model.repoId, treeGeneration: "tree", path: "", name: "known.txt", size: 1, sha: "a".repeat(40) });
    const repo = new Repository(model);
    Object.defineProperty(repo, "source", { get: () => ({ fetchFileInfoFromPath: async () => ({ path: "deep", name: "found.txt", size: 2, sha: "b".repeat(40) }) }) });
    expect(await repo.searchFiles("found")).to.have.length(0);
    expect((await new AnonymizedFile({ repository: repo, anonymizedPath: "deep/found.txt" }).getFileInfo()).name).to.equal("found.txt");
    const fresh = new Repository(await Repo.findById(model._id));
    expect(await fresh.searchFiles("found")).to.have.length(1);
    const size = await fresh.computeSize();
    expect({ storage: size.storage, file: size.file }).to.deep.equal({ storage: 3, file: 2 });
  });

  for (const repair of ["lookup", "maintenance"]) {
    it(`propagates recovered-file invalidation failures and retries them through ${repair}`, async () => {
      const model = await Repo.create({ repoId: "recover-failure", status: "ready", statusDate: new Date(), lastView: new Date(),
        treeGeneration: "tree", truncatedFolders: ["deep"], anonymizeDate: new Date(),
        source: { type: "GitHubStream", repositoryName: "owner/repo" }, options: { expirationMode: "never" } });
      await File.create({ repoId: model.repoId, treeGeneration: "tree", path: "", name: "known.txt", size: 1 });
      const repo = new Repository(model);
      Object.defineProperty(repo, "source", { get: () => ({ fetchFileInfoFromPath: async () => ({ path: "deep", name: "found.txt", size: 2 }) }) });
      await repo.searchFiles("found"); await repo.computeSize();
      repo.invalidateFileMetadata = async () => { throw Error("invalidation unavailable"); };
      try {
        await new AnonymizedFile({ repository: repo, anonymizedPath: "deep/found.txt" }).getFileInfo();
        throw Error("expected required invalidation to fail");
      } catch (error) { expect(error.message).to.equal("invalidation unavailable"); }
      expect((await File.findOne({ repoId: model.repoId, name: "found.txt" })).metadataPending).to.equal(true);
      const fresh = new Repository(await Repo.findById(model._id));
      if (repair === "lookup") {
        expect((await new AnonymizedFile({ repository: fresh, anonymizedPath: "deep/found.txt" }).getFileInfo()).name).to.equal("found.txt");
      } else await require("../src/server/schedule").runRepositoryStatusCheck();
      expect((await File.findOne({ repoId: model.repoId, name: "found.txt" })).metadataPending).to.equal(undefined);
      const repaired = new Repository(await Repo.findById(model._id));
      expect(await repaired.searchFiles("found")).to.have.length(1);
      const size = await repaired.computeSize();
      expect({ storage: size.storage, file: size.file }).to.deep.equal({ storage: 3, file: 2 });
    });
  }

  it("does not invalidate a replacement lifecycle and removes obsolete pending recoveries", async () => {
    const model = await Repo.create({ repoId: "obsolete-recovery", status: "ready", statusDate: new Date(), lastView: new Date(),
      treeGeneration: "old", source: { type: "GitHubStream" }, options: { expirationMode: "never" } });
    const stale = new Repository(model);
    await File.create({ repoId: model.repoId, treeGeneration: "old", path: "", name: "old.txt", metadataPending: true });
    await File.create({ repoId: model.repoId, treeGeneration: "new", path: "", name: "active.txt", size: 1 });
    await Repo.updateOne({ _id: model._id }, { $set: { treeGeneration: "new", fileMetadataRevision: "new", size: { storage: 1, file: 1 } } });
    try { await stale.invalidateFileMetadata(); throw Error("expected generation conflict"); }
    catch (error) { expect(error.message).to.equal("repository_changed"); }
    await require("../src/server/schedule").runRepositoryStatusCheck();
    expect(await File.countDocuments({ repoId: model.repoId, treeGeneration: "old" })).to.equal(0);
    expect(await File.countDocuments({ repoId: model.repoId, treeGeneration: "new" })).to.equal(1);
    const fresh = await Repo.findById(model._id);
    expect(fresh.fileMetadataRevision).to.equal("new"); expect(fresh.size.storage).to.equal(1);
  });

});
