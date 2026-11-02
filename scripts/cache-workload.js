/* Reproducible local acceptance workload. Never connects to production or downloads upstream files. */
const { strict: assert } = require("node:assert");
const { promises: fs } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Readable } = require("node:stream");
const { createHash } = require("node:crypto");
const http = require("node:http");
const express = require("express");
require("ts-node/register/transpile-only");
const config = require("../src/config").default;
const { BlobCache, sharedBlobCache, resultBlobCache, closeBlobCaches } = require("../src/core/blob-cache");
const { sendSharedContent } = require("../src/core/cached-response");
const { cacheMetricsReport, closeCacheMetrics } = require("../src/core/cache-observability");
const { monitorRequests } = require("../src/core/request-monitoring");
const consume = async s => { const chunks = []; for await (const b of s) chunks.push(Buffer.from(b)); return Buffer.concat(chunks); };
async function main() {
  const root = await fs.mkdtemp(join(tmpdir(), "cache-workload-")); let server, eviction;
  const old = { ...config };
  Object.assign(config, { SHARED_CACHE_ENABLED: true, SHARED_CACHE_PATH: root, SHARED_CACHE_BYTES: 1024 * 1024,
    SHARED_CACHE_RESULT_BYTES: 1024 * 1024, SHARED_CACHE_MAX_FILE_BYTES: 32768, SHARED_CACHE_FREE_BYTES: 0, CACHE_MONITORING_ENABLED: true });
  try {
    const source = sharedBlobCache();
    const content = Buffer.from("A public example with repeatable documentation.\n".repeat(400));
    const key = "git-" + createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    let fills = 0;
    const obtain = () => source.getOrFill(key, async () => { fills++; return Readable.from(content); }, async p => {
      assert.equal(key, "git-" + p.gitSha); return key;
    }, content.length);
    const app = express(); app.use(monitorRequests("api", undefined, { info() {}, warn() {} }));
    app.get("/:project/:rule", async (req, res) => {
      res.type("text/plain");
      try { assert.equal(await sendSharedContent(await obtain(), res, { filePath: "README.md", repoId: req.params.project,
        terms: req.params.rule === "changed" ? ["public=>private"] : ["Alice"] }), true); }
      catch (e) { res.destroy(e); }
    });
    await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
    const responses = [];
    for (const path of ["/a/plain", "/b/plain", "/a/plain", "/a/changed", "/a/changed"]) {
      responses.push(await new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: server.address().port, path, headers: { "accept-encoding": "gzip" } }, res => {
          consume(res).then(b => resolve({ status: res.statusCode, encoding: res.headers["content-encoding"], bytes: b.length }), reject);
        }).on("error", reject);
      }));
    }
    assert.equal(fills, 1); assert.ok(responses.every(r => r.status === 200 && r.encoding === "gzip"));
    eviction = new BlobCache({ root: join(root, "eviction"), budget: 65536, maxObject: 4096, gzip: false, name: "workload" });
    for (let i = 0; i < 30; i++) {
      const data = Buffer.alloc(4000, i);
      await consume(await eviction.getOrFill(`item-${i}`, async () => Readable.from(data)));
      const stats = eviction.stats(); assert.ok(stats.allocatedBytes + stats.reservedBytes <= stats.budgetBytes);
    }
    const stats = eviction.stats(); assert.ok(stats.blobs < 30);
    const metrics = cacheMetricsReport(60);
    const count = name => metrics.rows.filter(r => r.name === name).reduce((n, r) => n + r.count, 0);
    assert.equal(count("decision_hit"), 2); assert.equal(count("rewrite_changed"), 1);
    const result = { node: process.version, measuredAt: new Date().toISOString(), scope: "Synthetic local acceptance workload; not a production projection",
      sourceRequests: 5, upstreamFills: fills, source: source.stats(), results: resultBlobCache().stats(), eviction: stats,
      decisionsReused: count("decision_hit"), unchangedDecisionsComputed: count("rewrite_unchanged"), changedOutputsComputed: count("rewrite_changed"),
      compressionSavingPercent: 100 * (1 - source.stats().storedBytes / source.stats().originalBytes), responses, metrics: metrics.rows,
      assertions: "passed" };
    const json = JSON.stringify(result, null, 2) + "\n";
    if (process.argv[2]) await fs.writeFile(process.argv[2], json);
    process.stdout.write(json);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    eviction?.close(); closeBlobCaches(); closeCacheMetrics(); Object.assign(config, old); await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
