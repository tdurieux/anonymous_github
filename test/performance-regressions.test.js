const { expect } = require("chai");
const { Readable, PassThrough } = require("node:stream");
const { setImmediate } = require("node:timers");
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

  for (const phase of ["before download", "during publication"]) {
    it(`rejects retired cache producers ${phase} and removes late output`, async () => {
      const { contentGenerationPrefix, contentRetirementMarker } = require("../src/core/content-generation");
      const cacheGeneration = `retired-${phase}`, prefix = contentGenerationPrefix(cacheGeneration);
      const marker = contentRetirementMarker(prefix), objects = new Map();
      const source = new GitHubStream({ repoId: `retirement-${phase}`, organization: "owner", repoName: "repo", commit: "abc",
        cacheGeneration, getToken: async () => "token" });
      let downloads = 0, started, release;
      const began = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
      stub(storage, "fileInfo", async (_repo, path) => {
        if (!objects.has(path)) throw Object.assign(Error("missing"), { code: "ENOENT" });
        return { size: objects.get(path).length };
      });
      stub(storage, "write", async (_repo, path, input) => {
        started(); await held;
        let content = ""; for await (const chunk of input) content += chunk;
        objects.set(path, content);
      });
      stub(storage, "rm", async (_repo, path) => { objects.delete(path); });
      stub(storage, "read", async (_repo, path) => Readable.from([objects.get(path)]));
      source.downloadWithFallback = async () => { downloads++; return Readable.from(["obsolete"]); };
      if (phase === "before download") { objects.set(marker, "retired"); release(); }
      const pending = source.getFileContentCache("private/old.txt", source.data.repoId, () => ({ sha: "blob", size: 8 }));
      try {
        if (phase === "during publication") {
          await began; objects.set(marker, "retired"); release();
        }
        try { await pending; throw Error("expected retired generation rejection"); }
        catch (error) { expect(error.message).to.equal("repository_changed"); expect(error.httpStatus).to.equal(409); }
        expect(downloads).to.equal(phase === "before download" ? 0 : 1);
        expect([...objects.keys()]).to.deep.equal([marker]);
      } finally { release(); await pending.catch(() => {}); }
    });
  }

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

  for (const [upstream, code, status] of [
    [Object.assign(new Error("forbidden"), { response: { statusCode: 403 } }), "file_not_accessible", 403],
    [Object.assign(new Error("missing"), { response: { statusCode: 404 } }), "file_not_found", 404],
    [Object.assign(new Error("large"), { status: 422 }), "file_too_big", 422],
    [Object.assign(new Error("missing"), { httpStatus: 404 }), "file_not_found", 404],
    [Object.assign(new Error("reset"), { code: "ECONNRESET" }), "upstream_error", 502],
    [new (require("../src/core/AnonymousError").default)("file_not_accessible", { httpStatus: 403 }), "file_not_accessible", 403],
  ]) {
    it(`preserves ${code}/${status} for failed downloads (${upstream.message})`, async () => {
      const source = new GitHubStream({ repoId: "failed-download", organization: "owner", repoName: "repo", getToken: () => "token" });
      const input = new PassThrough();
      stub(storage, "fileInfo", async () => { throw Error("cache miss"); });
      let committed = false;
      stub(storage, "write", async (_repo, _path, stream) => { for await (const chunk of stream) void chunk; committed = true; });
      source.downloadWithFallback = async () => { setImmediate(() => input.destroy(upstream)); return input; };
      try { await source.getFileContentCache("file.txt", "failed-download", () => ({ sha: "blob", size: 1 })); throw Error("expected failure"); }
      catch (error) {
        expect(error.message).to.equal(code); expect(error.httpStatus).to.equal(status);
        if (upstream instanceof require("../src/core/AnonymousError").default) expect(error).to.equal(upstream);
        else expect(error.cause).to.equal(upstream);
      }
      expect(committed).to.equal(false); expect(input.destroyed).to.equal(true);
    });
  }

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
