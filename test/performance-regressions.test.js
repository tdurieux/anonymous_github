const { expect } = require("chai");
const { Readable, PassThrough } = require("node:stream");
const { setTimeout: delay } = require("node:timers/promises");
require("ts-node/register/transpile-only");
const { AsyncCache } = require("../src/core/async-cache");
const { streamResponse } = require("../src/core/response-stream");
const Repository = require("../src/core/Repository").default;
const User = require("../src/core/User").default;
const UserModel = require("../src/core/model/users/users.model").default;
const RepoModel = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const GitHubStream = require("../src/core/source/GitHubStream").default;
const storage = require("../src/core/storage").default;
const { dashboardPipeline } = require("../src/server/routes/dashboard-summary");

describe("performance regressions", function () {
  this.timeout(10000);
  const restore = [];
  function stub(object, key, value) { const before = object[key]; object[key] = value; restore.push(() => { object[key] = before; }); }
  afterEach(() => { restore.splice(0).reverse().forEach(fn => fn()); });

  it("keeps name/folder search semantics and stops at 500 matches", async () => {
    const repo = new Repository(new RepoModel({ owner: new UserModel()._id, repoId: "search", options: { terms: [] } }));
    const rows = Array.from({ length: 10000 }, (_, i) => ({ name: `file-${i}.ts`, path: `src/MATCH-${i}/nested`, size: i }));
    let examined = 0;
    for (const row of rows) { const name = row.name; Object.defineProperty(row, "name", { get() { examined++; return name; } }); }
    repo.anonymizedFiles = async () => rows;
    const result = await repo.searchFiles("match");
    expect(result).to.have.length(500);
    expect(result[499].path).to.equal("src/MATCH-499/nested");
    expect(examined).to.be.lessThan(2000);
    expect(await repo.searchFiles("src/MATCH")).to.deep.equal([]);
  });

  it("coalesces cache misses, caches zero, bounds keys, and retries failures", async () => {
    let now = 0, calls = 0;
    const cache = new AsyncCache(10, 3, () => now);
    const values = await Promise.all(Array.from({ length: 10 }, () => cache.get("zero", async () => { calls++; await delay(10); return 0; })));
    expect(values).to.deep.equal(Array(10).fill(0));
    expect(calls).to.equal(1);
    for (let i = 0; i < 1000; i++) await cache.get(String(i), async () => i);
    expect(cache.size).to.equal(3);
    now = 11;
    expect(cache.size).to.equal(0);
    await cache.get("failure", async () => { throw Error("temporary"); }).catch(() => {});
    expect(await cache.get("failure", async () => 1)).to.equal(1);
  });

  for (const terminal of ["close", "finish", "error"]) {
    it(`destroys the upstream and removes listeners on response ${terminal}`, async () => {
      const input = new PassThrough(), response = new PassThrough();
      const completed = streamResponse(input, response, () => {});
      response.emit(terminal, new Error("disconnected"));
      await completed.catch(() => {});
      expect(input.destroyed).to.equal(true);
      expect(response.listenerCount("close")).to.equal(0);
      expect(response.listenerCount("finish")).to.equal(0);
      expect(response.listenerCount("error")).to.equal(0);
    });
  }

  it("performs one cache fill for ten callers and gives each its own stream", async () => {
    const source = new GitHubStream({ repoId: "coalesced", organization: "owner", repoName: "repo", commit: "abc", getToken: async () => "token" });
    let data, downloads = 0, writes = 0, heads = 0;
    stub(storage, "fileInfo", async () => { heads++; if (!data) throw Error("missing"); return { size: data.length }; });
    stub(storage, "read", async () => Readable.from([data]));
    stub(storage, "write", async (_repo, _path, input) => { writes++; const chunks = []; for await (const chunk of input) chunks.push(chunk); await delay(10); data = Buffer.concat(chunks); });
    source.downloadWithFallback = async () => { downloads++; return Readable.from([Buffer.from("complete content")]); };
    const streams = await Promise.all(Array.from({ length: 10 }, () => source.getFileContentCache("file.txt", "coalesced", () => ({ sha: "blob", size: 16 }))));
    expect(downloads).to.equal(1); expect(writes).to.equal(1);
    expect(new Set(streams).size).to.equal(10);
    for (const input of streams) { let text = ""; for await (const chunk of input) text += chunk; expect(text).to.equal("complete content"); }
    heads = 0;
    const warm = await source.getFileContentCache("file.txt", "coalesced", () => ({ sha: "blob", size: 16 }));
    warm.destroy(); expect(heads).to.equal(1); expect(downloads).to.equal(1);
  });

  it("fetches a complete root tree in one recursive request", async () => {
    const source = new GitHubStream({ repoId: "tree", organization: "owner", repoName: "repo", commit: "head", getToken: () => "token" });
    const calls = [];
    source.getGHTree = async (_oct, _token, sha, _count, options) => {
      calls.push({ sha, recursive: options.recursive });
      return { truncated: false, tree: Array.from({ length: 20 }, (_, i) => ({ path: `folder${i}/file.ts`, type: "blob", sha: "abc" })) };
    };
    const files = await source.getTruncatedTree("head");
    expect(files).to.have.length(20); expect(calls).to.deep.equal([{ sha: "head", recursive: true }]);
  });

  it("falls back to shallow trees when GitHub truncates recursive results", async () => {
    const source = new GitHubStream({ repoId: "tree", organization: "owner", repoName: "repo", commit: "head", getToken: () => "token" });
    const calls = [];
    source.getGHTree = async (_oct, _token, sha, _count, options) => {
      calls.push(`${sha}:${options.recursive}`);
      if (sha === "head" && options.recursive) return { truncated: true, tree: [{ path: "ignored.ts", type: "blob" }] };
      if (sha === "head") return { truncated: false, tree: [{ path: "src", type: "tree", sha: "src" }] };
      return { truncated: false, tree: [{ path: "file.ts", type: "blob", sha: "abc" }] };
    };
    const files = await source.getTruncatedTree("head");
    expect(files.map(file => `${file.path}/${file.name}`)).to.deep.equal(["/src", "src/file.ts"]);
    expect(calls).to.deep.equal(["head:true", "head:false", "src:true"]);
  });

  it("does no physical expiration work while reading 100 expired projects", async () => {
    const user = new User(new UserModel({ username: "owner" }));
    stub(RepoModel, "find", () => ({ exec: async () => Array.from({ length: 100 }, (_, i) => new RepoModel({ repoId: `expired${i}`, owner: user.model._id, status: "ready", options: { expirationMode: "remove", expirationDate: new Date(0) } })) }));
    stub(Repository.prototype, "expire", () => { throw Error("inline cleanup"); });
    const projects = await user.getRepositories();
    expect(projects).to.have.length(100);
    expect(projects.every(project => project.status === "expiring")).to.equal(true);
  });

  it("projects dashboard summaries before combining types, and validates cursors", () => {
    const user = new User(new UserModel({ username: "owner" }));
    const pipeline = dashboardPipeline(user, { limit: 2, type: "pr" });
    const projection = pipeline.find(stage => stage.$project).$project;
    expect(projection).not.to.have.property("pullRequest");
    expect(pipeline.filter(stage => stage.$unionWith)).to.have.length(2);
    expect(() => dashboardPipeline(user, { cursor: "bogus" })).to.throw("invalid_cursor");
    expect(() => dashboardPipeline(user, { sort: "$where" })).to.throw("invalid_sort");
  });
});

describe("shared home statistics", function () {
  this.timeout(10000);
  const stats = require("../src/server/dailyStatsSnapshot");
  const PR = require("../src/core/model/anonymizedPullRequests/anonymizedPullRequests.model").default;
  const Daily = require("../src/core/model/dailyStats/dailyStats.model").default;
  let originals, calculations, fail;
  beforeEach(() => {
    stats.clearStatsCache(); calculations = 0; fail = false;
    originals = [RepoModel.estimatedDocumentCount, RepoModel.collection.aggregate, PR.estimatedDocumentCount, Daily.find];
    RepoModel.estimatedDocumentCount = async () => { calculations++; if (fail) throw Error("temporary stats error"); return 0; };
    RepoModel.collection.aggregate = () => ({ toArray: async () => [] });
    PR.estimatedDocumentCount = async () => 0;
    Daily.find = () => ({ sort: () => ({ lean: async () => [] }) });
  });
  afterEach(() => {
    [RepoModel.estimatedDocumentCount, RepoModel.collection.aggregate, PR.estimatedDocumentCount, Daily.find] = originals;
    stats.clearStatsCache();
  });
  it("coalesces concurrent current/history calculations and caches zero across day ranges", async () => {
    const values = await Promise.all([...Array.from({ length: 10 }, () => stats.getCurrentStats()),
      stats.getStatsHistory(30, new Date("2026-10-07")), stats.getStatsHistory(60, new Date("2026-10-07"))]);
    expect(calculations).to.equal(1); expect(values[0].nbRepositories).to.equal(0);
    expect(values[10][0].date.toISOString()).to.equal("2026-10-07T00:00:00.000Z");
    const next = await stats.getStatsHistory(30, new Date("2026-10-08"));
    expect(next[0].date.toISOString()).to.equal("2026-10-08T00:00:00.000Z");
    expect(calculations).to.equal(1);
  });
  it("retries a failed calculation without retaining a rejected promise", async () => {
    fail = true; await stats.getCurrentStats().catch(() => {}); fail = false;
    expect((await stats.getCurrentStats()).nbPageViews).to.equal(0);
    expect(calculations).to.equal(2);
  });
});

describe("admin queue snapshot reuse", function () {
  it("filters a bounded raw snapshot for thousands of search terms and expires it", async function () {
    this.timeout(10000);
    const queues = require("../src/queue");
    const metrics = require("../src/queue/queueMetrics");
    const router = require("../src/server/routes/admin").default;
    const handler = router.stack.find(layer => layer.route?.path === "/queues").route.stack.at(-1).handle;
    const originals = [queues.downloadQueue, queues.removeQueue, queues.cacheQueue, metrics.queryMetrics, Date.now];
    let calls = 0, now = Date.now();
    const queue = { getJobCounts: async () => ({}), getWorkers: async () => [], isPaused: async () => false,
      getJobs: async ([state]) => { calls++; return state === "active" ? [{ asJSON: () => ({ id: "known", name: "known" }) }] : []; } };
    queues.downloadQueue = queue; queues.removeQueue = queue; queues.cacheQueue = queue;
    metrics.queryMetrics = async () => [];
    Date.now = () => now;
    try {
      for (let i = 0; i < 1000; i++) await handler({ query: { search: `unique-${i}` } }, { json: data => expect(data.jobs).to.have.length(0) });
      const firstCalls = calls;
      expect(firstCalls).to.equal(5);
      await handler({ query: { search: "known" } }, { json: data => expect(data.jobs).to.have.length(1) });
      expect(calls).to.equal(firstCalls);
      now += 10001;
      await handler({ query: {} }, { json() {} });
      expect(calls).to.equal(firstCalls * 2);
    } finally {
      [queues.downloadQueue, queues.removeQueue, queues.cacheQueue, metrics.queryMetrics, Date.now] = originals;
    }
  });
});
