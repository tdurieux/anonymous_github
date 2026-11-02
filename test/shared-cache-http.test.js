const { strict: assert } = require("node:assert");
const { promises: fs } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const http = require("node:http");
const { Readable } = require("node:stream");
const { createHash } = require("node:crypto");
const { gunzipSync } = require("node:zlib");
const express = require("express");
require("ts-node/register/transpile-only");
const config = require("../src/config").default;
const { sharedBlobCache, resultBlobCache, closeBlobCaches } = require("../src/core/blob-cache");
const { sendSharedContent } = require("../src/core/cached-response");
const { closeCacheMetrics, cacheMetricsReport, observeCache } = require("../src/core/cache-observability");
const { monitorRequests } = require("../src/core/request-monitoring");
const GitHubStream = require("../src/core/source/GitHubStream").default;
const sha = b => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
const consume = async s => { const chunks = []; for await (const b of s) chunks.push(Buffer.from(b)); return Buffer.concat(chunks); };
function request(port, path, encoding = "gzip", extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers: { "accept-encoding": encoding, ...extra } }, res => {
      consume(res).then(body => resolve({ status: res.statusCode, headers: res.headers, body }), reject);
    }); req.on("error", reject);
  });
}
describe("shared cache HTTP and telemetry integration", function () {
  this.timeout(15000);
  let root, old, server, port, fills, body;
  beforeEach(async () => {
    old = { ...config }; closeBlobCaches(); closeCacheMetrics();
    root = await fs.mkdtemp(join(tmpdir(), "shared-http-"));
    Object.assign(config, { FOLDER: root, SHARED_CACHE_PATH: join(root, "cache"), SHARED_CACHE_ENABLED: true,
      SHARED_CACHE_BYTES: 16 * 1024 ** 2, SHARED_CACHE_RESULT_BYTES: 8 * 1024 ** 2, SHARED_CACHE_MAX_FILE_BYTES: 1024 ** 2,
      SHARED_CACHE_FREE_BYTES: 0, CACHE_MONITORING_ENABLED: true });
    fills = 0; body = Buffer.from("Public documentation with no identifying names.\n".repeat(100));
    const app = express(); app.use(monitorRequests("api", undefined, { info() {}, warn() {} }));
    app.get("/:project/:mode", async (req, res) => {
      if (req.headers.authorization !== "test-access") return res.status(403).end();
      const source = new GitHubStream({ repoId: req.params.project, organization: "org", repoName: "repo", commit: "commit", getToken: async () => "" });
      source.downloadWithFallback = async () => { fills++; return Readable.from(body); };
      source.downloadFile = () => Readable.from("invalid pointer");
      const filePath = String(req.query.name || "README.md");
      const mime = require("mime-types").lookup(filePath);
      if (mime) res.type(mime);
      try {
        const input = await source.getFileContentCache(filePath, req.params.project, () => ({ sha: sha(body), size: body.length }));
        const handled = await sendSharedContent(input, res, { filePath, repoId: req.params.project,
          terms: req.params.mode === "changed" ? ["Public=>Private"] : ["Alice"] });
        if (!handled) res.send(await consume(input));
      } catch (e) { if (!res.headersSent) res.status(500).end(e.message); else res.destroy(e); }
    });
    await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); }); port = server.address().port;
  });
  afterEach(async () => {
    await new Promise(resolve => server.close(resolve)); closeBlobCaches(); closeCacheMetrics(); Object.assign(config, old);
    await fs.rm(root, { recursive: true, force: true });
  });
  const headers = { authorization: "test-access" };
  it("shares source content across projects without bypassing authorization", async () => {
    assert.equal((await request(port, "/a/plain")).status, 403); assert.equal(fills, 0);
    const a = await request(port, "/a/plain", "gzip", headers);
    assert.equal(a.status, 200); assert.equal(a.headers["content-encoding"], "gzip"); assert.deepEqual(gunzipSync(a.body), body);
    const b = await request(port, "/b/plain", "identity", headers);
    assert.deepEqual(b.body, body); assert.equal(b.headers["content-encoding"], undefined); assert.equal(fills, 1);
    assert.equal(sharedBlobCache().stats().blobs, 1); assert.equal(resultBlobCache().stats().blobs, 0);
    assert.equal((await request(port, "/b/plain", "gzip")).status, 403);
  });
  it("fetches public submodule content from its origin without forwarding parent credentials", async () => {
    const original = GitHubStream.prototype.downloadWithFallback;
    const upstream = { organization: "public-org", repoName: "dependency", commit: "a".repeat(40), path: "src/data.txt" };
    let calls = 0;
    GitHubStream.prototype.downloadWithFallback = async function (token, digest, path) {
      calls++;
      assert.equal(token, ""); assert.equal(digest, sha(body)); assert.equal(path, upstream.path);
      assert.equal(this.data.organization, upstream.organization); assert.equal(this.data.repoName, upstream.repoName);
      assert.equal(this.data.commit, upstream.commit);
      return Readable.from(body);
    };
    try {
      const source = new GitHubStream({ repoId: "parent", organization: "private-org", repoName: "parent",
        commit: "parent-commit", getToken: async () => "parent-secret" });
      const meta = () => ({ sha: sha(body), size: body.length, upstream });
      assert.deepEqual(await consume(await source.getFileContentCache("vendor/src/data.txt", "parent", meta)), body);
      assert.deepEqual(await consume(await source.getFileContentCache("vendor/src/data.txt", "parent", meta)), body);
      assert.equal(calls, 1);
    } finally { GitHubStream.prototype.downloadWithFallback = original; }
  });
  for (const changed of [false, true]) it("preserves sniffed text MIME on initial and cached responses: " + changed, async () => {
    for (const encoding of ["gzip", "identity"]) {
      const r = await request(port, "/a/" + (changed ? "changed" : "plain") + "?name=data.unknownext", encoding, headers);
      assert.equal(r.status, 200); assert.match(r.headers["content-type"], /^text\/plain/);
      const decoded = r.headers["content-encoding"] === "gzip" ? gunzipSync(r.body) : r.body;
      assert.equal(decoded.toString(), changed ? body.toString().replaceAll("Public", "Private") : body.toString());
    }
  });
  for (const name of ["video.mp4", "audio.mp3", "binary.unknownext"]) it("omits the range-denial header for binary " + name, async () => {
    body = Buffer.from([0, 1, 2, 0, 255]);
    for (let i = 0; i < 2; i++) {
      const r = await request(port, "/a/plain?name=" + name, "identity", headers);
      assert.equal(r.status, 200); assert.equal(r.headers["accept-ranges"], undefined);
      assert.notEqual(r.headers["content-type"], "text/plain; charset=utf-8"); assert.deepEqual(r.body, body);
    }
  });
  it("bypasses a contended source index without failing a download", async () => {
    await request(port, "/a/plain", "identity", headers);
    const { BlobCache } = require("../src/core/blob-cache");
    const other = new BlobCache(sharedBlobCache().options); other.db.exec("BEGIN IMMEDIATE");
    try {
      const r = await request(port, "/a/plain", "identity", headers);
      assert.equal(r.status, 200); assert.deepEqual(r.body, body); assert.equal(fills, 2);
    } finally { other.db.exec("ROLLBACK"); other.close(); }
  });
  it("bypasses a contended result index while retaining the source fallback", async () => {
    await request(port, "/a/plain", "identity", headers);
    const { BlobCache } = require("../src/core/blob-cache");
    const other = new BlobCache(resultBlobCache().options); other.db.exec("BEGIN IMMEDIATE");
    try {
      const r = await request(port, "/a/plain", "identity", headers);
      assert.equal(r.status, 200); assert.deepEqual(r.body, body); assert.equal(fills, 1);
    } finally { other.db.exec("ROLLBACK"); other.close(); }
  });
  for (const bypass of [false, true]) for (const streamed of [false, true]) {
    it("normalizes upstream permission errors for " + JSON.stringify({ bypass, streamed }), async () => {
      if (bypass) sharedBlobCache().options.budget = 1;
      const source = new GitHubStream({ repoId: "errors", organization: "org", repoName: "repo", commit: "commit", getToken: async () => "" });
      source.downloadWithFallback = async () => {
        const error = Object.assign(Error("forbidden"), { response: { statusCode: 403 } });
        if (!streamed) throw error;
        return Readable.from((async function* () { yield Buffer.alloc(0); throw error; })());
      };
      await assert.rejects(async () => consume(await source.getFileContentCache("data.txt", "errors", () => ({ sha: sha(body), size: body.length }))),
        error => error.message === "file_not_accessible" && error.httpStatus === 403);
    });
  }
  it("rejects truncated admission-bypass downloads before successful completion", async () => {
    sharedBlobCache().options.budget = 1;
    const source = new GitHubStream({ repoId: "short", organization: "org", repoName: "repo", commit: "commit", getToken: async () => "" });
    source.downloadWithFallback = async () => Readable.from("short");
    await assert.rejects(async () => consume(await source.getFileContentCache("data.txt", "short", () => ({ sha: sha(body), size: 20 }))),
      error => error.message === "storage_write_size_mismatch" && error.httpStatus === 502);
  });
  it("classifies parent repository misses before returning a shared-download error", async () => {
    const misses = require("../src/core/source/github-content-miss"), original = misses.classifyContentMiss;
    let classified = 0;
    misses.classifyContentMiss = async () => { classified++; return "repo_not_found"; };
    try {
      const source = new GitHubStream({ repoId: "missing-parent", organization: "org", repoName: "repo", commit: "missing-parent", getToken: async () => "" });
      source.downloadWithFallback = async () => { throw Object.assign(Error("missing"), { status: 404 }); };
      await assert.rejects(source.getFileContentCache("data.txt", "missing-parent", () => ({ sha: sha(body), size: body.length })),
        error => error.message === "repo_not_found" && error.httpStatus === 404);
      assert.equal(classified, 1);
    } finally { misses.classifyContentMiss = original; }
  });
  it("classifies unavailable submodule streams on cache bypass", async () => {
    sharedBlobCache().options.budget = 1;
    const original = GitHubStream.prototype.downloadWithFallback;
    GitHubStream.prototype.downloadWithFallback = async () => Readable.from((async function* () {
      yield Buffer.alloc(0);
      throw Object.assign(Error("missing"), { response: { statusCode: 404 } });
    })());
    try {
      const source = new GitHubStream({ repoId: "errors", organization: "org", repoName: "repo", commit: "commit", getToken: async () => "" });
      await assert.rejects(async () => consume(await source.getFileContentCache("vendor/data.txt", "errors", () => ({ sha: sha(body), size: body.length,
        upstream: { organization: "public", repoName: "dependency", commit: "a".repeat(40), path: "data.txt" } }))),
      error => error.message === "submodule_not_available" && error.httpStatus === 404);
    } finally { GitHubStream.prototype.downloadWithFallback = original; }
  });
  it("reuses unchanged decisions, separates changed rules, and caches small changed output", async () => {
    const first = await request(port, "/a/plain", "gzip", headers);
    const second = await request(port, "/a/plain", "gzip", headers);
    assert.deepEqual(second.body, first.body);
    const changed = await request(port, "/a/changed", "gzip", headers);
    assert.equal(gunzipSync(changed.body).toString(), body.toString().replaceAll("Public", "Private"));
    const repeated = await request(port, "/a/changed", "identity", headers);
    assert.equal(repeated.body.toString(), body.toString().replaceAll("Public", "Private"));
    assert.equal(resultBlobCache().stats().blobs, 1);
    const report = cacheMetricsReport(60); assert.equal(report.available, true);
    const count = name => report.rows.filter(r => r.name === name).reduce((n, r) => n + r.count, 0);
    assert.equal(count("rewrite_unchanged"), 1); assert.equal(count("rewrite_changed"), 1); assert.equal(count("decision_hit"), 2);
  });
  it("respects gzip q=0, rejects all forbidden encodings, and gzip-encodes small identity blobs when required", async () => {
    let r = await request(port, "/a/plain", "gzip;q=0, identity;q=1", headers);
    assert.equal(r.headers["content-encoding"], undefined); assert.deepEqual(r.body, body);
    r = await request(port, "/a/plain", "gzip;q=0, identity;q=0", headers); assert.equal(r.status, 406);
    body = Buffer.from("tiny text");
    r = await request(port, "/a/plain", "gzip, identity;q=0", headers);
    assert.equal(r.headers["content-encoding"], "gzip"); assert.deepEqual(gunzipSync(r.body), body);
    assert.ok(r.headers.vary.includes("Accept-Encoding"));
  });
  it("verifies the Git LFS pointer and resolved payload before sharing the payload", async () => {
    const payload = Buffer.from("large file payload");
    const pointer = Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${createHash("sha256").update(payload).digest("hex")}\nsize ${payload.length}\n`);
    const source = new GitHubStream({ repoId: "lfs", organization: "org", repoName: "repo", commit: "commit", getToken: async () => "" });
    source.downloadWithFallback = async () => Readable.from(payload);
    source.downloadFile = () => Readable.from(pointer);
    assert.deepEqual(await consume(await source.getFileContentCache("data.bin", "lfs", () => ({ sha: sha(pointer), size: pointer.length }))), payload);
    const badPointer = Buffer.from(pointer.toString().replace(`size ${payload.length}`, "size 999"));
    source.downloadFile = () => Readable.from(badPointer);
    await assert.rejects(source.getFileContentCache("bad.bin", "lfs", () => ({ sha: sha(badPointer), size: badPointer.length })), /invalid_blob_hash/);
    assert.equal(sharedBlobCache().stats().blobs, 1);
  });
  it("uses bounded persistent metrics with separate monitoring traffic and no file identifiers", async () => {
    await request(port, "/a/plain", "identity", { ...headers, "user-agent": "Uptime-Kuma/1" });
    observeCache("compress", 100, 1, "zip");
    const report = cacheMetricsReport(60);
    assert.ok(report.rows.some(r => r.traffic === "monitor")); assert.ok(report.rows.some(r => r.traffic === "zip"));
    assert.ok(!JSON.stringify(report).includes("README")); assert.ok(!JSON.stringify(report).includes(sha(body)));
    config.CACHE_MONITORING_ENABLED = false; assert.equal(cacheMetricsReport().available, false);
  });
});
