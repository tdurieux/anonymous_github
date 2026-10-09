const { expect } = require("chai");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
require("ts-node/register/transpile-only");
const config = require("../src/config").default;
const credentials = require("../src/core/credentials");
const { refreshLegacyToken } = require("../src/core/legacy-token-refresh");
const { ExpiringMap } = require("../src/core/expiring-map");
const { sendRequestRateLimit } = require("../src/server/request-rate-limit");
const GitHubStream = require("../src/core/source/GitHubStream").default;
const storage = require("../src/core/storage").default;
const { logSummary, observeLine, containerSummary } = require("../scripts/check-production-logs");

describe("production failure fixes", function () {
  this.timeout(20000);
  const restores = [];
  function stub(object, key, value) { const old = object[key]; object[key] = value; restores.push(() => { object[key] = old; }); }
  afterEach(() => restores.splice(0).reverse().forEach(restore => restore()));
  for (const mode of ["401", "reset", "lfs", "fallback", "public-raw"]) {
    it(`contains ${mode} upstream stream errors in a process with no recovery handler`, function () {
      const result = spawnSync(process.execPath, [path.join(__dirname, "fixtures/github-stream-failure.js"), mode], {
        timeout: 15000, encoding: "utf8", env: { ...process.env, NODE_ENV: "test", GITHUB_APP_ENABLED: "false", REDIS_HOSTNAME: "127.0.0.1", REDIS_PORT: "1" },
      });
      expect(result.status, result.stderr).to.equal(0);
      expect(result.stdout).to.include("failure contained");
    });
  }
  it("records a fatal event without keeping a broken process running", function () {
    const result = spawnSync(process.execPath, [path.join(__dirname, "fixtures/github-stream-failure.js"), "fatal"], {
      timeout: 15000, encoding: "utf8", env: { ...process.env, NODE_ENV: "test", GITHUB_APP_ENABLED: "false", REDIS_PORT: "1" },
    });
    expect(result.status).to.equal(1);
    expect(result.stderr + result.stdout).to.include("process_fatal_error");
  });
  function oauth() {
    stub(config, "GITHUB_OAUTH_ENABLED", true); stub(config, "CLIENT_ID", "test-client"); stub(config, "CLIENT_SECRET", "test-secret");
  }
  it("coalesces token refreshes and backs off on permanent 404 responses without replacing credentials", async () => {
    oauth(); let calls = 0, replacements = 0;
    stub(globalThis, "fetch", async () => { calls++; return { ok: false, status: 404, body: { cancel: async () => {} } }; });
    stub(credentials, "replaceCredential", async () => { replacements++; return true; });
    const first = await Promise.all(Array.from({ length: 8 }, () => refreshLegacyToken("owner-failure", "gho_first")));
    expect(first).to.deep.equal(Array(8).fill(null));
    expect(await refreshLegacyToken("owner-failure", "gho_first")).to.equal(null);
    expect(calls).to.equal(1); expect(replacements).to.equal(0);
    await refreshLegacyToken("owner-failure", "gho_reconnected"); expect(calls).to.equal(2);
    config.CLIENT_SECRET = "rotated-secret";
    await refreshLegacyToken("owner-failure", "gho_first"); expect(calls).to.equal(3);
  });
  it("skips PAT and GitHub App tokens and disabled OAuth", async () => {
    oauth(); stub(globalThis, "fetch", () => { throw Error("unexpected refresh"); });
    for (const token of ["ghp_token", "ghs_token", "ghu_token", "ghr_token", "github_pat_token"]) expect(await refreshLegacyToken("owner", token)).to.equal(null);
    config.GITHUB_OAUTH_ENABLED = false; expect(await refreshLegacyToken("owner", "gho_token")).to.equal(null);
  });
  it("keeps a newer login when the refresh compare-and-swap loses", async () => {
    oauth(); stub(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => ({ token: "refreshed" }) }));
    stub(credentials, "replaceCredential", async () => false);
    stub(credentials, "getCredentialToken", async () => "new-login");
    expect(await refreshLegacyToken("owner-race", "gho_old")).to.equal("new-login");
  });
  it("backs off on network failures while leaving the current token intact", async () => {
    oauth(); let calls = 0;
    stub(globalThis, "fetch", async () => { calls++; throw Error("network failure"); });
    expect(await refreshLegacyToken("owner-network", "gho_old")).to.equal(null);
    expect(await refreshLegacyToken("owner-network", "gho_old")).to.equal(null);
    expect(calls).to.equal(1);
  });
  it("bounds failure caches and expires entries so repaired content can be retried", () => {
    let now = 0; const cache = new ExpiringMap(2, () => now);
    cache.set("a", true, 30); cache.set("b", true, 30); cache.set("c", true, 30);
    expect(cache.get("a")).to.equal(undefined); expect(cache.get("b")).to.equal(true);
    now = 30; expect(cache.get("b")).to.equal(undefined); expect(cache.get("c")).to.equal(undefined);
  });
  it("caches confirmed file misses by credential and commit, without caching permission failures", async () => {
    let token = "credential-a", attempts = 0, now = Date.now();
    stub(Date, "now", () => now);
    stub(storage, "fileInfo", async () => { throw Object.assign(Error("missing"), { code: "ENOENT" }); });
    stub(storage, "write", async (_repo, _path, input) => { for await (const chunk of input) void chunk; });
    const source = new GitHubStream({ repoId: "missing-fixture", organization: "owner", repoName: "repo", commit: "first", getToken: () => token });
    source.downloadWithFallback = async () => { attempts++; throw Object.assign(Error("missing"), { response: { statusCode: 404 } }); };
    const read = () => source.getFileContentCache("missing.js", "missing-fixture", () => ({ sha: "sha" }));
    for (let i = 0; i < 3; i++) { try { await read(); } catch (error) { expect(error.httpStatus || error.response?.statusCode).to.equal(404); } }
    expect(attempts).to.equal(1);
    token = "credential-b"; await read().catch(() => {}); expect(attempts).to.equal(2);
    source.data.commit = "second"; await read().catch(() => {}); expect(attempts).to.equal(3);
    now += 30001; await read().catch(() => {}); expect(attempts).to.equal(4);
    source.downloadWithFallback = async () => { attempts++; throw Object.assign(Error("forbidden"), { response: { statusCode: 403 } }); };
    now += 30001; await read().catch(() => {}); await read().catch(() => {}); expect(attempts).to.equal(6);
  });
  it("does not cache a storage 404 as a missing upstream file", async () => {
    let attempts = 0;
    stub(storage, "fileInfo", async () => { throw Object.assign(Error("missing"), { code: "ENOENT" }); });
    stub(storage, "write", async (_repo, _path, input) => {
      for await (const chunk of input) void chunk;
      throw Object.assign(Error("storage unavailable"), { httpStatus: 404 });
    });
    const source = new GitHubStream({ repoId: "storage-failure-fixture", organization: "owner", repoName: "repo", commit: "first", getToken: () => "token" });
    source.downloadWithFallback = async () => { attempts++; return require("node:stream").Readable.from(["content"]); };
    for (let i = 0; i < 2; i++) {
      try { await source.getFileContentCache("file.js", source.data.repoId, () => ({ sha: "sha" })); throw Error("expected storage failure"); }
      catch (error) { expect(error.message).to.equal("storage unavailable"); }
    }
    expect(attempts).to.equal(2);
  });
  it("returns a client error from the real options route for an inaccessible source", async () => {
    const utils = require("../src/server/routes/route-utils");
    const repo = { assertNotArchived() {}, status: "error", options: {},
      model: { statusDate: new Date(), statusMessage: "repo_not_found", source: {} } };
    stub(utils, "getRepo", async () => repo); stub(utils, "getUser", async () => { throw Error("anonymous"); });
    const router = require("../src/server/routes/repository-public").default;
    const handler = router.stack.find(layer => layer.route?.path === "/:repoId/options").route.stack[0].handle;
    const res = { header() {}, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
    await handler({ params: { repoId: "inaccessible" } }, res);
    expect(res.statusCode).to.equal(404); expect(res.body).to.deep.equal({ error: "repo_not_found" });
    repo.model.statusMessage = "unexpected_bug";
    await handler({ params: { repoId: "inaccessible" } }, res); expect(res.statusCode).to.equal(500);
  });
  it("returns a structured 429 and the actual store retry time", () => {
    const headers = {}, res = { setHeader: (key, value) => { headers[key] = value; }, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
    const resetAt = Date.now() + 10000;
    sendRequestRateLimit({ rateLimit: { resetTime: new Date(resetAt) } }, res);
    expect(res.statusCode).to.equal(429); expect(res.body).to.deep.equal({ error: "rate_limited", resetAt });
    expect(Number(headers["Retry-After"])).to.be.within(9, 10);
  });
  it("flags native unhandled stream errors and restarts without reporting private log fields", () => {
    const summary = logSummary();
    observeLine(summary, "throw er; // Unhandled 'error' event");
    observeLine(summary, '2026-10-09T00:00:00Z ERROR [process] process fatal error {"code":"process_fatal_error","message":"private data"}');
    observeLine(summary, '2026-10-09T00:00:00Z INFO [requests] request {"status":502,"outcome":"completed","ms":100,"url":"private"}');
    expect(summary.fatalErrors).to.equal(2); expect(summary.completed5xx).to.equal(1); expect(JSON.stringify(summary)).not.to.include("private");
    expect(containerSummary({ Name: "/streamer", RestartCount: 3, State: { Running: true, Health: { Status: "healthy" }, OOMKilled: false, StartedAt: "now" } }).restartCount).to.equal(3);
  });
});
