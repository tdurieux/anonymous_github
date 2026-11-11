const { expect } = require("chai");
require("ts-node/register/transpile-only");
const mongoose = require("mongoose");
const config = require("../src/config").default;
const db = require("../src/server/database");
const Repo = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const File = require("../src/core/model/files/files.model").default;
const { assertTransformScopeActive } = require("../src/core/transformed-cache");
const GitHubStream = require("../src/core/source/GitHubStream").default;
const { reconcileNeverExpiration } = require("../src/core/billing/expiration");
const { retireFileIndexes } = require("../src/scripts/retire-file-indexes");
const uri = process.env.PERFORMANCE_MONGO_URI;
const owner = new mongoose.Types.ObjectId();
const replacement = { repoId: 1, treeGeneration: 1, path: 1, name: 1 };

(uri ? describe : describe.skip)("Mongo index audit regressions", function () {
  this.timeout(60000);
  const originalBilling = config.BILLING_ENABLED;
  before(async () => {
    if (!/\/perf_test_[A-Za-z0-9_-]+(?:\?|$)/.test(uri)) throw Error("Use an isolated perf_test_ database");
    await mongoose.connect(uri); db.isConnected = true;
    await Promise.all([Repo, File].map(m => m.createIndexes()));
  });
  after(async () => {
    config.BILLING_ENABLED = originalBilling; db.isConnected = false;
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  });
  beforeEach(async () => { await Repo.deleteMany({}); await File.deleteMany({}); });

  it("uses the case-insensitive index for cache guards without weakening lifecycle or revision checks", async () => {
    const when = new Date("2026-01-01");
    const repo = await Repo.create({ repoId: "Mixed-Case", owner, status: "ready", treeGeneration: "generation",
      anonymizeDate: when, contentCacheRevision: "revision" });
    const options = { repoId: "mixed-case", cacheGeneration: `generation:${when.toISOString()}`, cacheRevision: "revision" };
    const find = Repo.findOne; let query;
    Repo.findOne = function (...args) { query = find.apply(this, args); return query; };
    try {
      await assertTransformScopeActive(options);
      const plan = await query.clone().explain("executionStats");
      expect(plan.executionStats.totalDocsExamined).to.equal(1);
      expect(plan.executionStats.totalKeysExamined).to.equal(1);
    } finally { Repo.findOne = find; }
    for (const patch of [{ cacheGeneration: "stale" }, { cacheRevision: "stale" }]) {
      const error = await assertTransformScopeActive({ ...options, ...patch }).catch(e => e);
      expect(error.message).to.equal("repository_changed");
    }
    await Repo.updateOne({ _id: repo._id }, { $set: { status: "archived" } });
    const error = await assertTransformScopeActive(options).catch(e => e);
    expect(error.message).to.equal("repository_changed");
  });

  it("keeps raw-cache generation guards indexed and rejects a stale snapshot before upstream work", async () => {
    await Repo.create({ repoId: "Mixed-Case", owner, status: "ready", treeGeneration: "new" });
    const find = Repo.findOne; let query;
    Repo.findOne = function (...args) { query = find.apply(this, args); return query; };
    try {
      const source = new GitHubStream({ cacheGeneration: "old:", getToken: () => { throw Error("unexpected upstream"); } });
      const error = await source.getFileContentCache("README.md", "mixed-case", () => ({ sha: "a".repeat(40) }), true).catch(e => e);
      expect(error.message).to.equal("repository_changed");
      const plan = await query.clone().explain("executionStats");
      expect(plan.executionStats.totalDocsExamined).to.equal(1);
      expect(plan.executionStats.totalKeysExamined).to.equal(1);
    } finally { Repo.findOne = find; }
  });

  it("uses the partial billing index and excludes legacy never-expiring repositories", async () => {
    config.BILLING_ENABLED = true;
    await Repo.insertMany(Array.from({ length: 1000 }, (_, i) => ({ repoId: `legacy-${i}`, owner,
      status: "ready", options: { expirationMode: "never" } })));
    await Repo.insertMany(Array.from({ length: 11 }, (_, i) => ({ repoId: `paid-${i}`, owner,
      status: "ready", options: { expirationMode: "never" }, billingNeverExpiresUntil: new Date("2099-01-01") })));
    const find = Repo.find; let query;
    Repo.find = function (...args) { query = find.apply(this, args); return query; };
    try {
      await reconcileNeverExpiration(new Date("2026-01-01"), async () => { throw Error("unexpected reconciliation"); });
      const plan = await query.clone().explain("executionStats");
      expect(plan.executionStats.nReturned).to.equal(11);
      expect(plan.executionStats.totalDocsExamined).to.equal(11);
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).to.include("billing_never_expiration");
    } finally { Repo.find = find; }
    expect(await Repo.countDocuments({ billingNeverExpiresUntil: { $exists: false }, "options.expirationMode": "never" })).to.equal(1000);
  });

  it("hides, restores and only then drops the audited indexes while preserving file reads", async () => {
    const coll = File.collection;
    for (const [key, name] of [[{ path: 1 }, "path_1"], [{ path: 1, repoId: 1 }, "path_1_repoId_1"], [{ repoId: 1, path: 1 }, "repoIDAndPath"]]) {
      await coll.createIndex(key, { name });
    }
    await File.insertMany([{ repoId: "fixture", treeGeneration: "active", path: "src", name: "one", size: 1 },
      { repoId: "fixture", path: "legacy", name: "two", size: 2 }]);
    const database = mongoose.connection.db;
    const rejected = await retireFileIndexes(database, "drop").catch(e => e);
    expect(rejected.message).to.include("Hide all");
    await retireFileIndexes(database, "hide");
    expect((await coll.indexes()).find(i => i.name === "path_1").hidden).to.equal(true);
    for (const filter of [{ repoId: "fixture", treeGeneration: "active", path: "src" },
      { repoId: "fixture", treeGeneration: { $exists: false }, path: "legacy" }]) {
      expect(await File.countDocuments(filter)).to.equal(1);
    }
    await retireFileIndexes(database, "restore");
    expect((await coll.indexes()).find(i => i.name === "path_1").hidden).not.to.equal(true);
    await retireFileIndexes(database, "hide"); await retireFileIndexes(database, "drop");
    const indexes = await coll.indexes();
    expect(indexes.some(i => i.name === "path_1")).to.equal(false);
    expect(indexes.some(i => JSON.stringify(i.key) === JSON.stringify(replacement))).to.equal(true);
  });

  it("refuses hiding when the replacement index is absent", async () => {
    await File.collection.dropIndex("repoId_1_treeGeneration_1_path_1_name_1");
    try {
      const error = await retireFileIndexes(mongoose.connection.db, "hide").catch(e => e);
      expect(error.message).to.include("replacement index must be ready");
    } finally { await File.collection.createIndex(replacement); }
  });

  it("refuses retirement of an unexpectedly unique candidate", async () => {
    await File.collection.createIndex({ path: 1 }, { name: "path_1", unique: true });
    try {
      const error = await retireFileIndexes(mongoose.connection.db, "hide").catch(e => e);
      expect(error.message).to.include("Unexpected definition");
    } finally { await File.collection.dropIndex("path_1"); }
  });
});
