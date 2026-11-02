const { expect } = require("chai");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
require("ts-node/register/transpile-only");
const mongoose = require("mongoose");
const db = require("../src/server/database");
const Repository = require("../src/core/Repository").default;
const Repo = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const File = require("../src/core/model/files/files.model").default;
const Path = require("../src/core/model/anonymized-path").default;
const { FILE_TREE_BATCH_SIZE, FILE_LISTING_LIMIT, deleteRowsInBatches } = require("../src/core/file-tree");
const GitHubStream = require("../src/core/source/GitHubStream").default;
const { expandSubmodules, MAX_SUBMODULES } = require("../src/core/source/github-submodules");
const github = require("../src/core/GitHubUtils");
const config = require("../src/config").default;

describe("large repository tree allocation", function () {
  this.timeout(120000);
  it("reads two million entries within a 256 MiB V8 heap", async () => {
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--max-old-space-size=256", path.join(__dirname, "fixtures/large-repository-tree.js")],
      { timeout: 110000, maxBuffer: 262144, env: { ...process.env, NODE_ENV: "test", SESSION_SECRET: "large-tree-test" } });
    expect(JSON.parse(stdout).count).to.equal(2000200);
  });

  it("does not fetch child trees before the consumer advances past the parent page", async () => {
    const source = new GitHubStream({ repoId: "backpressure", organization: "fixture", repoName: "repo", commit: "head", getToken: () => "fixture" });
    let calls = 0;
    source.getGHTree = async (_oct, _token, _sha, _count, options) => {
      calls++;
      return options.recursive ? { truncated: true, tree: [] }
        : { tree: [{ path: "folder", type: "tree", sha: "a".repeat(40) }] };
    };
    const iterator = source.iterateFiles();
    expect((await iterator.next()).value.name).to.equal("folder");
    expect(calls).to.equal(2);
    await iterator.return();
    expect(calls).to.equal(2);
  });

  it("rejects an oversized pending-folder queue before fetching its children", async () => {
    const source = new GitHubStream({ repoId: "wide", organization: "fixture", repoName: "repo", commit: "head", getToken: () => "fixture" });
    let calls = 0;
    source.getGHTree = async (_oct, _token, _sha, _count, options) => {
      calls++;
      return options.recursive ? { truncated: true, tree: [] }
        : { tree: Array.from({ length: 100001 }, (_, i) => ({ path: `folder${i}`, type: "tree", sha: String(i) })) };
    };
    const error = await (async () => { for await (const file of source.iterateFiles()) void file; })().then(() => null, error => error);
    expect(error.message).to.equal("repository_tree_too_large"); expect(error.httpStatus).to.equal(413); expect(calls).to.equal(2);
  });

  it("applies the submodule budget across separate tree pages", async () => {
    const octokit = github.octokit, gate = github.waitForTokenGate;
    const budget = { modules: 0, remaining: 10000 }, sha = "a".repeat(40);
    let calls = 0;
    github.waitForTokenGate = async () => {};
    github.octokit = () => ({ repos: { getContent: async () => {
      calls++; return { data: { submodule_git_url: "https://github.com/child/public.git", sha } };
    } }, git: { getTree: async () => ({ data: { tree: [], truncated: false } }) } });
    const data = { repoId: "modules", organization: "fixture", repoName: "repo", commit: "head", getToken: () => "fixture" };
    try {
      for (let i = 0; i <= MAX_SUBMODULES; i++) {
        const [mount] = await expandSubmodules([{ name: `child${i}`, path: "vendor", sha, submodule: "unsupported" }], data, budget);
        expect(mount.submodule).to.equal(i < MAX_SUBMODULES ? "included" : "limit");
      }
      expect(calls).to.equal(MAX_SUBMODULES);
    } finally { github.octokit = octokit; github.waitForTokenGate = gate; }
  });
});

const uri = process.env.PERFORMANCE_MONGO_URI;
(uri ? describe : describe.skip)("large repository persistence and cleanup", function () {
  this.timeout(60000);
  let previousFolder, folder;
  before(async () => {
    if (!/\/perf_test_[A-Za-z0-9_-]+(?:\?|$)/.test(uri)) throw Error("An isolated perf_test_ database is required");
    await mongoose.connect(uri);
    db.isConnected = true;
    previousFolder = config.FOLDER;
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "large-tree-tests-")); config.FOLDER = folder;
    await Promise.all([Repo, File, Path].map(model => model.createIndexes()));
  });
  after(async () => {
    db.isConnected = false;
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
    config.FOLDER = previousFolder; await fs.rm(folder, { recursive: true, force: true });
  });
  beforeEach(async () => { await Promise.all([Repo, File, Path].map(model => model.deleteMany({}))); });
  const owner = new mongoose.Types.ObjectId();
  const repository = (extra = {}) => Repo.create({ repoId: "large", owner, status: "preparing", statusDate: new Date(),
    source: { type: "GitHubStream", repositoryName: "fixture/repo", commit: "a".repeat(40) }, ...extra });
  async function rows(count, extra = {}) {
    for (let offset = 0; offset < count; offset += FILE_TREE_BATCH_SIZE) {
      await File.collection.insertMany(Array.from({ length: Math.min(count - offset, FILE_TREE_BATCH_SIZE) }, (_, i) => ({
        repoId: "large", treeGeneration: "old", name: `file${offset + i}.txt`, path: "", size: 1, sha: "b".repeat(40),
        ...(typeof extra === "function" ? extra(offset + i) : extra),
      })));
    }
  }

  it("persists streamed input in bounded batches without reading a listing after preparation", async () => {
    const row = await repository(), repo = new Repository(row), insert = File.insertMany;
    let produced = 0, persisted = 0, calls = 0;
    Object.defineProperty(repo, "source", { get: () => ({
      getFiles: () => { throw Error("unbounded source read"); },
      async *iterateFiles() {
        for (let i = 0; i < 1503; i++) { produced++; yield { name: `file${i}.txt`, path: "", size: i, sha: "b".repeat(40) }; }
      },
    }) });
    repo.files = () => { throw Error("preparation reloaded the tree"); };
    File.insertMany = async function (batch, ...args) {
      expect(batch.length).to.be.at.most(FILE_TREE_BATCH_SIZE);
      expect(produced).to.equal(persisted + batch.length);
      const model = await Repo.findById(row._id);
      expect(model.stagedFileTrees.some(stage => stage.generation === batch[0].treeGeneration)).to.equal(true);
      const result = await insert.call(this, batch, ...args); persisted += batch.length; calls++; return result;
    };
    try { await repo.anonymize(); } finally { File.insertMany = insert; }
    expect(calls).to.equal(4); expect(persisted).to.equal(1503);
    expect(await File.countDocuments({ repoId: row.repoId, treeGeneration: repo.model.treeGeneration })).to.equal(1503);
    expect((await Repo.findById(row._id)).status).to.equal("ready");
    expect(await File.countDocuments({ treeStaged: true })).to.equal(0);
  });

  it("retires preparation metadata without deleting it in the request, and resumes interrupted cleanup", async () => {
    const row = await repository({ treeGeneration: "old", pathIndexKey: "old-key" }), repo = new Repository(row);
    await rows(1201);
    await File.create({ repoId: "unrelated", treeGeneration: "old", name: "keep.txt", path: "" });
    await Path.collection.insertOne({ repoId: row.repoId, key: "old-key", anonymousPath: "old.txt" });
    const fileDelete = File.collection.deleteMany, pathDelete = Path.collection.deleteMany;
    File.collection.deleteMany = Path.collection.deleteMany = () => { throw Error("foreground metadata deletion"); };
    try { await repo.resetSate("preparing"); }
    finally { File.collection.deleteMany = fileDelete; Path.collection.deleteMany = pathDelete; }
    let current = await Repo.findById(row._id);
    expect(current.treeGeneration).not.to.equal("old"); expect(current.retiredTreeGenerations).to.deep.equal(["old"]);
    expect(current.retiredPathIndexKeys).to.deep.equal(["old-key"]);
    expect(await File.countDocuments({ repoId: row.repoId })).to.equal(1201);
    await File.create({ repoId: row.repoId, treeGeneration: current.treeGeneration, name: "active.txt", path: "" });
    await Path.collection.insertOne({ repoId: row.repoId, key: "active-key", anonymousPath: "active.txt" });
    await Repo.updateOne({ _id: row._id }, { $set: { pathIndexKey: "active-key" } });
    let batches = 0;
    File.collection.deleteMany = async function (filter, ...args) {
      expect(filter._id.$in.length).to.be.at.most(FILE_TREE_BATCH_SIZE);
      if (++batches === 2) throw Error("interrupted cleanup");
      return fileDelete.call(this, filter, ...args);
    };
    try { await repo.cleanupRetiredFileTrees().then(() => { throw Error("expected interruption"); }, error => expect(error.message).to.equal("interrupted cleanup")); }
    finally { File.collection.deleteMany = fileDelete; }
    expect((await Repo.findById(row._id)).retiredTreeGenerations).to.deep.equal(["old"]);
    await repo.cleanupRetiredFileTrees();
    expect((await File.find({ repoId: row.repoId })).map(file => file.name)).to.deep.equal(["active.txt"]);
    expect((await Path.find({ repoId: row.repoId })).map(file => file.key)).to.deep.equal(["active-key"]);
    expect(await File.countDocuments({ repoId: "unrelated" })).to.equal(1);
    current = await Repo.findById(row._id);
    expect(current.retiredTreeGenerations).to.equal(undefined); expect(current.retiredPathIndexKeys).to.equal(undefined);
  });

  it("stops ingestion between batches when another tree replaces its build", async () => {
    const row = await repository({ treeGeneration: "old" }), repo = new Repository(row), insert = File.insertMany;
    let produced = 0, calls = 0, closed = false;
    Object.defineProperty(repo, "source", { get: () => ({ getFiles: () => { throw Error("unbounded read"); },
      async *iterateFiles() {
        try { for (let i = 0; i < 1500; i++) { produced++; yield { name: `file${i}.txt`, path: "", size: i }; } }
        finally { closed = true; }
      },
    }) });
    File.insertMany = async function (...args) {
      const result = await insert.apply(this, args); calls++;
      await Repo.updateOne({ _id: row._id }, { $set: { treeGeneration: "replacement" } });
      await File.create({ repoId: row.repoId, treeGeneration: "replacement", name: "keep.txt", path: "" });
      return result;
    };
    let error;
    try { error = await repo.anonymize().then(() => null, error => error); } finally { File.insertMany = insert; }
    expect(error.message).to.equal("repository_changed"); expect(calls).to.equal(1); expect(produced).to.equal(1000); expect(closed).to.equal(true);
    expect(await File.countDocuments({ repoId: row.repoId, treeGeneration: "replacement" })).to.equal(1);
    expect(await File.countDocuments({ repoId: row.repoId, treeStaged: true })).to.equal(500);
  });

  it("retains retirement markers when foreground cleanup reaches its batch budget", async () => {
    const row = await repository({ treeGeneration: "active", retiredTreeGenerations: ["old"] }), repo = new Repository(row);
    await rows(501);
    await repo.cleanupRetiredFileTrees(new Date(), 1);
    expect(await File.countDocuments({ repoId: row.repoId })).to.equal(1);
    expect((await Repo.findById(row._id)).retiredTreeGenerations).to.deep.equal(["old"]);
    await repo.cleanupRetiredFileTrees();
    expect(await File.countDocuments({ repoId: row.repoId })).to.equal(0);
  });

  it("stops expiration deletion when its lifecycle claim changes between batches", async () => {
    const row = await repository({ status: "expiring", treeGeneration: "old" }), repo = new Repository(row);
    await rows(1001);
    const original = File.collection.deleteMany; let calls = 0;
    File.collection.deleteMany = async function (...args) {
      const result = await original.apply(this, args); calls++;
      await Repo.updateOne({ _id: row._id }, { $set: { status: "ready", treeGeneration: "replacement", fileMetadataRevision: "replacement" } });
      await File.create({ repoId: row.repoId, treeGeneration: "replacement", name: "keep.txt", path: "" });
      return result;
    };
    try { await repo.expire(); } finally { File.collection.deleteMany = original; }
    expect(calls).to.equal(1); expect((await Repo.findById(row._id)).status).to.equal("ready");
    expect(await File.countDocuments({ repoId: row.repoId, treeGeneration: "replacement" })).to.equal(1);
    expect(await File.countDocuments({ repoId: row.repoId, treeGeneration: "old" })).to.equal(501);
  });

  it("rejects oversized listings before hydration while allowing narrower folder reads", async () => {
    const row = await repository({ status: "ready", treeGeneration: "old" }), repo = new Repository(row);
    await rows(FILE_LISTING_LIMIT + 1);
    await File.create({ repoId: row.repoId, treeGeneration: "old", name: "small.txt", path: "specific", size: 2, sha: "c".repeat(40) });
    const error = await repo.files({ recursive: false }).then(() => null, error => error);
    expect(error.message).to.equal("file_listing_too_large"); expect(error.httpStatus).to.equal(413);
    const files = await repo.files({ recursive: false, path: "specific" });
    expect(files).to.have.length(1); expect(files[0].name).to.equal("small.txt");
    expect(files[0]).not.to.be.instanceOf(mongoose.Document);
  });

  it("preserves rows that stop matching the deletion filter after selection", async () => {
    await rows(2);
    const complete = await deleteRowsInBatches(File.collection, { repoId: "large", treeGeneration: "old" }, {
      current: async () => { await File.updateMany({ repoId: "large" }, { $set: { treeGeneration: "replacement" } }); return true; },
    });
    expect(complete).to.equal(true); expect(await File.countDocuments({ repoId: "large" })).to.equal(2);
  });

  for (const ancestors of [false, true]) it(`bounds ${ancestors ? "ancestor expansion" : "direct folders"} in folder-count responses`, async () => {
    const row = await repository({ status: "ready", treeGeneration: "old" }), repo = new Repository(row);
    await rows(ancestors ? 3000 : FILE_LISTING_LIMIT + 1, i => ({ path: ancestors ? `folder${i}/a/b/c` : `folder${i}` }));
    const utils = require("../src/server/routes/route-utils"), getRepo = utils.getRepo, handleError = utils.handleError;
    const router = require("../src/server/routes/repository-public").default;
    const handler = router.stack.find(layer => layer.route?.path === "/:repoId/files/counts").route.stack.at(-1).handle;
    utils.getRepo = async () => repo; utils.handleError = error => { throw error; };
    try {
      const error = await handler({ params: { repoId: row.repoId } }, { header() {}, json() { throw Error("unbounded counts returned"); } })
        .then(() => null, error => error);
      expect(error.message).to.equal("file_listing_too_large"); expect(error.httpStatus).to.equal(413);
    } finally { utils.getRepo = getRepo; utils.handleError = handleError; }
  });
});
