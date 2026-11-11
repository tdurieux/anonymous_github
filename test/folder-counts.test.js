const { expect } = require("chai");
require("ts-node/register/transpile-only");
const mongoose = require("mongoose");
const db = require("../src/server/database");
const Repository = require("../src/core/Repository").default;
const Repo = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const File = require("../src/core/model/files/files.model").default;
const Path = require("../src/core/model/anonymized-path").default;
const { folderCounts } = require("../src/core/folder-counts");
const { FILE_LISTING_LIMIT } = require("../src/core/file-tree");
const uri = process.env.PERFORMANCE_MONGO_URI;

describe("folder count request validation", () => {
  for (const value of [[], {}, 1, "../private", "a/../b", "/src", "src/", "x".repeat(4097)]) {
    it(`rejects invalid scope ${JSON.stringify(value).slice(0, 30)}`, async () => {
      const error = await folderCounts({}, value).then(() => null, error => error);
      expect(error.message).to.equal("invalid_path"); expect(error.httpStatus).to.equal(400);
    });
  }
});

(uri ? describe : describe.skip)("scoped folder counts with MongoDB", function () {
  this.timeout(60000);
  let repo;
  before(async () => {
    if (!/\/perf_test_[A-Za-z0-9_-]+(?:\?|$)/.test(uri)) throw Error("An isolated perf_test_ database is required");
    await mongoose.connect(uri); db.isConnected = true;
    await Promise.all([Repo, File, Path].map(model => model.createIndexes()));
  });
  after(async () => { db.isConnected = false; await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => {
    await Promise.all([Repo, File, Path].map(model => model.deleteMany({})));
    repo = new Repository(await Repo.create({ repoId: "counts", owner: new mongoose.Types.ObjectId(), status: "ready",
      statusDate: new Date(), anonymizeDate: new Date(), treeGeneration: "active", source: { type: "GitHubStream", repositoryName: "fixture/repo" }, options: { terms: [] } }));
  });
  const insert = rows => File.insertMany(rows.map(row => ({ repoId: "counts", treeGeneration: "active", ...row })));

  it("returns only the current directory and immediate children across a large deep tree", async () => {
    await insert([{ name: "src", path: "" }, { name: "root.txt", path: "", size: 1 }]);
    for (let offset = 0; offset < 12000; offset += 500) await insert(Array.from({ length: 500 }, (_, i) => ({
      name: "file.txt", path: `src/deep/folder${offset + i}`, size: 1,
    })));
    await insert([{ name: "ignored.txt", path: "staged", size: 1, treeGeneration: "staged" },
      { name: "ignored.txt", path: "old", size: 1, treeGeneration: "old" }]);
    expect(await folderCounts(repo, "")).to.deep.equal({ "": 12001, src: 12000 });
    expect(await folderCounts(repo, "src")).to.deep.equal({ src: 12000, "src/deep": 12000 });
  });

  it("covers root counts without fetching documents and counts every file in a directory", async () => {
    await insert(Array.from({ length: 2000 }, (_, i) => ({ name: `file${i}`, path: `src/folder${i % 20}`, size: i % 2 })));
    await insert([{ name: "excluded-directory", path: "" },
      { name: "old", path: "old", size: 1, treeGeneration: "retired" }]);
    let pipeline;
    const aggregate = File.aggregate;
    File.aggregate = function (stages, ...args) { pipeline = stages; return aggregate.call(this, stages, ...args); };
    try { expect(await folderCounts(repo, "")).to.deep.equal({ "": 2000, src: 2000 }); }
    finally { File.aggregate = aggregate; }
    const explained = await File.aggregate(pipeline).option({ hint: "file_counts_covering" }).explain("executionStats");
    const cursor = explained.stages?.find(stage => stage.$cursor)?.$cursor || explained;
    expect(cursor.executionStats.totalDocsExamined).to.equal(0);
    expect(cursor.executionStats.totalKeysExamined).to.be.at.least(2000);
  });

  it("preserves counts for legacy repositories without a generation", async () => {
    repo.model.treeGeneration = undefined; await repo.model.save();
    await File.collection.insertMany([
      { repoId: "counts", name: "zero", path: "", size: 0 },
      { repoId: "counts", name: "one", path: "src", size: 1 },
      { repoId: "counts", name: "folder", path: "" },
      { repoId: "counts", name: "staged", path: "src", size: 1, treeGeneration: "future" },
    ]);
    expect(await folderCounts(repo, "")).to.deep.equal({ "": 2, src: 1 });
  });

  it("escapes regex punctuation and handles Unicode scopes and empty directories", async () => {
    await insert([{ path: "", name: "猫.[x]" }, { path: "猫.[x]", name: "empty" },
      { path: "猫.[x]/child", name: "a", size: 0 }, { path: "猫.[x]", name: "b", size: 2 },
      { path: "猫Xx/not-this-folder", name: "no", size: 3 }]);
    expect(await folderCounts(repo, "猫.[x]")).to.deep.equal({ "猫.[x]": 2, "猫.[x]/child": 1 });
    expect(await folderCounts(repo, "猫.[x]/empty")).to.deep.equal({ "猫.[x]/empty": 0 });
  });

  it("anonymizes child keys, sums collisions and resolves the same directory as browsing", async () => {
    repo.model.options.terms = ["Alice|Bob"];
    await repo.model.save();
    await insert([{ name: "Alice", path: "" }, { name: "Bob", path: "" },
      { name: "one", path: "Alice/sub", size: 1 }, { name: "two", path: "Bob/sub", size: 1 }]);
    const root = await folderCounts(repo, "");
    expect(root).to.deep.equal({ "": 2, "XXXX-1": 2 });
    const scoped = await folderCounts(repo, "XXXX-1");
    expect(scoped).to.deep.equal({ "XXXX-1": 1, "XXXX-1/sub": 1 });
    expect(JSON.stringify(scoped)).not.to.match(/Alice|Bob/);
  });

  for (const name of ["$data", "$$ROOT", "$$CURRENT"]) it(`treats directory ${name} as a literal in aggregation expressions`, async () => {
    await insert([{ name, path: "" }, { name: "direct.txt", path: name, size: 1 },
      { name: "$nested", path: name }, { name: "child.txt", path: `${name}/$nested`, size: 1 }]);
    expect(await folderCounts(repo, name)).to.deep.equal({ [name]: 2, [`${name}/$nested`]: 1 });
    expect(await folderCounts(repo, `${name}/$nested`)).to.deep.equal({ [`${name}/$nested`]: 1 });
  });

  it("uses the active generation on each request without reusing obsolete counts", async () => {
    await insert([{ path: "old", name: "a", size: 1 }]);
    expect(await folderCounts(repo, "")).to.deep.equal({ "": 1, old: 1 });
    await insert([{ path: "new", name: "b", size: 1, treeGeneration: "replacement" },
      { path: "new", name: "c", size: 1, treeGeneration: "replacement" }]);
    repo.model.treeGeneration = "replacement"; await repo.model.save();
    expect(await folderCounts(new Repository(await Repo.findById(repo.model._id)), "")).to.deep.equal({ "": 2, new: 2 });
  });

  it("keeps a hard bound for over-wide responses", async () => {
    for (let offset = 0; offset <= FILE_LISTING_LIMIT; offset += 500) await insert(Array.from({
      length: Math.min(500, FILE_LISTING_LIMIT + 1 - offset),
    }, (_, i) => ({ name: "a", path: `folder${offset + i}`, size: 1 })));
    const error = await folderCounts(repo, "").then(() => null, error => error);
    expect(error.message).to.equal("file_listing_too_large"); expect(error.httpStatus).to.equal(413);
  });

  it("runs the scoped route only after authorization and rejects object scopes", async () => {
    const utils = require("../src/server/routes/route-utils");
    const original = { getRepo: utils.getRepo, handleError: utils.handleError };
    const router = require("../src/server/routes/repository-public").default;
    const handler = router.stack.find(layer => layer.route?.path === "/:repoId/files/counts").route.stack.at(-1).handle;
    const res = { header() {}, json() { throw Error("must not return counts"); } };
    try {
      utils.getRepo = async () => null;
      await handler({ query: { path: {} } }, res);
      utils.getRepo = async () => repo; utils.handleError = error => { throw error; };
      const error = await handler({ query: { path: {} } }, res).then(() => null, error => error);
      expect(error.httpStatus).to.equal(400);
    } finally { Object.assign(utils, original); }
  });
});
