const { expect } = require("chai");
const express = require("express");
const compression = require("compression");
const http = require("node:http");
const net = require("node:net");
const { setTimeout } = require("node:timers");
const { gunzipSync } = require("node:zlib");
const { Readable } = require("node:stream");
const { setTimeout: delay } = require("node:timers/promises");
require("ts-node/register/transpile-only");
const { RequestMetrics, monitorRequests, requestRoute, requestHeaders, startStage, requestMetrics, activeRequestCount } = require("../src/core/request-monitoring");
const { percentileUpperBound, socketSnapshot, performanceReport } = require("../src/core/performance-monitoring");
const GitHubStream = require("../src/core/source/GitHubStream").default;
const storage = require("../src/core/storage").default;

function fetch(server, path, options = {}) {
  return new Promise((resolve, reject) => {
    http.request({ host: "127.0.0.1", port: server.address().port, path, ...options }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject).end();
  });
}

describe("bounded request monitoring", function () {
  let server, metrics, logs, app;
  beforeEach(function () {
    metrics = new RequestMetrics(); logs = []; requestMetrics.drain();
    app = express(); app.use(monitorRequests("api", metrics, { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) }));
    app.use(compression({ filter: () => true }));
  });
  afterEach(async function () {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
    requestMetrics.drain();
  });
  async function listen() { server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); }); }

  it("keeps labels bounded and removes source identities and query values", function () {
    expect(requestRoute("/api/repo/private-name/file/secret.txt?token=abc", "api")).to.equal("/api/repo/:repoId/file/:path");
    expect(requestRoute("/api/repo/secret-owner/secret-repo/readme?branch=secret", "api")).to.equal("/api/repo/:owner/:repo/readme");
    expect(requestRoute("/api/repo/id/files/counts", "api")).to.equal("/api/repo/:repoId/files/counts");
    const labels = new Set(Array.from({ length: 10000 }, (_, i) => requestRoute(`/unknown-${i}/private-${i}`, "api")));
    expect([...labels]).to.deep.equal(["other"]);
    expect(requestRoute("/healthcheck", "streamer")).to.equal("/healthcheck");
    const bounded = new RequestMetrics(3);
    for (let i = 0; i < 1000; i++) bounded.observe("request", String(i), "GET", 10);
    expect(bounded.size).to.equal(3); expect(bounded.dropped).to.equal(997);
  });

  it("records histogram upper bounds and releases the batch after flushing", function () {
    [1, 20, 51, 150, 501, 50000, 70000].forEach(ms => metrics.observe("request", "other", "GET", ms));
    const row = metrics.drain()[0].data;
    expect(row.count).to.equal(7); expect(row.sumMs).to.equal(120723);
    expect(percentileUpperBound(row.buckets, .5)).to.equal(250);
    expect(percentileUpperBound(row.buckets, .95)).to.equal(null);
    expect(metrics.size).to.equal(0); expect(metrics.drain()).to.deep.equal([]);
  });

  for (const gzip of [false, true]) {
    it(`preserves backpressure and ${gzip ? "gzip" : "plain"} bytes`, async function () {
      this.timeout(10000);
      const body = Buffer.alloc(2 * 1024 * 1024, "content-");
      let drains = 0, callbacks = 0;
      app.get("/api/repo/:repoId/file/*path", async (_req, res) => {
        res.type("text/plain");
        for (let i = 0; i < body.length; i += 16384) {
          if (!res.write(body.subarray(i, i + 16384), () => callbacks++)) {
            drains++;
            await new Promise(resolve => {
              const drained = () => { emitter.removeListener("drain", drained); resolve(); };
              const emitter = res.on("drain", drained);
            });
          }
        }
        res.end();
      });
      await listen();
      const result = await fetch(server, "/api/repo/private/file/private.txt?token=secret", { headers: { "Accept-Encoding": gzip ? "gzip" : "identity" } });
      expect(gzip ? gunzipSync(result.body) : result.body).to.deep.equal(body);
      expect(drains).to.be.greaterThan(0);
      // Compression omits write callbacks; the plain writable must retain them.
      expect(callbacks).to.equal(gzip ? 0 : body.length / 16384);
      const row = metrics.drain().find(row => row.data.metric === "request").data;
      expect(row.bytes).to.equal(result.body.length); expect(row.aborted).to.equal(0); expect(row.count).to.equal(1);
      expect(JSON.stringify(logs)).not.to.include("private.txt"); expect(JSON.stringify(logs)).not.to.include("secret");
      expect(logs[0][1].requestId).to.equal(result.headers["x-request-id"]);
      expect(activeRequestCount()).to.equal(0);
    });
  }

  it("counts HEAD as a zero-byte response even when a handler writes a body", async function () {
    app.get("/", (_req, res) => res.send("body omitted by Node")); await listen();
    const result = await fetch(server, "/", { method: "HEAD" });
    expect(result.body.length).to.equal(0);
    expect(metrics.drain().find(row => row.data.metric === "request").data.bytes).to.equal(0);
  });

  for (const headersSent of [false, true]) {
    it(`records a disconnect ${headersSent ? "after" : "before"} headers exactly once`, async function () {
      let arrived; const ready = new Promise(resolve => { arrived = resolve; });
      let finished; const terminal = new Promise(resolve => { finished = resolve; });
      app.get("/", (_req, res) => { if (headersSent) { res.type("text/plain"); res.write("partial"); } arrived(); res.on("close", finished); });
      await listen();
      const client = http.get({ host: "127.0.0.1", port: server.address().port, path: "/" }); client.on("error", () => {});
      await ready; client.destroy(); await terminal;
      expect(logs).to.have.length(1); expect(logs[0][0]).to.equal("request interrupted");
      expect(logs[0][1].outcome).to.equal("interrupted");
      const row = metrics.drain().find(row => row.data.metric === "request").data;
      expect(row.count).to.equal(1); expect(row.aborted).to.equal(1); expect(activeRequestCount()).to.equal(0);
      if (!headersSent) expect(logs[0][1].firstByteMs).to.equal(null);
    });
  }

  it("keeps overlapping request IDs and asynchronous stages isolated", async function () {
    let doneA, doneB;
    app.get("/a", (_req, res) => { doneA = startStage("upstream"); setTimeout(() => { doneA(); doneA(); res.json(requestHeaders()); }, 30); });
    app.get("/b", (_req, res) => { doneB = startStage("repository"); setTimeout(() => { doneB(); res.json(requestHeaders()); }, 10); });
    await listen(); const results = await Promise.all([fetch(server, "/a"), fetch(server, "/b")]);
    for (const result of results) expect(JSON.parse(result.body)["x-request-id"]).to.equal(result.headers["x-request-id"]);
    expect(results[0].headers["x-request-id"]).not.to.equal(results[1].headers["x-request-id"]);
    expect(logs.filter(row => row[1].stages.upstream)).to.have.length(1);
    expect(logs.filter(row => row[1].stages.repository)).to.have.length(1);
    expect(requestMetrics.drain().reduce((count, row) => count + row.data.count, 0)).to.equal(2);
    expect(requestHeaders()).to.deep.equal({});
  });

  it("covers delays and errors before route handling", async function () {
    app.use((_req, _res, next) => setTimeout(next, 35)); app.use(express.json());
    app.get("/", (_req, res) => res.status(503).json({ error: "unavailable" })); await listen();
    const response = await fetch(server, "/"); expect(response.status).to.equal(503);
    const row = metrics.drain().find(row => row.data.metric === "request").data;
    expect(row.errors).to.equal(1); expect(row.sumMs).to.be.at.least(30);
  });

  for (const failure of [false, true]) {
    it(`includes GitHub response-header waits in upstream timing${failure ? " on failure" : ""}`, async function () {
      const originals = { fileInfo: storage.fileInfo, write: storage.write, read: storage.read };
      const source = new GitHubStream({ repoId: `headers-${failure}`, organization: "owner", repoName: "repo", commit: "abc", getToken: async () => "token" });
      const upstreamError = Error("headers failed");
      source.downloadWithFallback = async () => {
        await delay(120);
        if (failure) throw upstreamError;
        return Readable.from([Buffer.from("content")]);
      };
      storage.fileInfo = async () => { throw Error("cache miss"); };
      storage.write = async (_repo, _path, input) => { for await (const chunk of input) void chunk; };
      storage.read = async () => Readable.from([Buffer.from("content")]);
      app.get("/", async (_req, res) => {
        try {
          const input = await source.getFileContentCache("file.txt", source.data.repoId, () => ({ sha: "blob", size: 7 }));
          input.destroy(); res.send("ok");
        } catch (error) { res.status(502).send(error.cause === upstreamError ? "original error" : "unexpected error"); }
      });
      try {
        await listen(); const response = await fetch(server, "/");
        expect(response.status).to.equal(failure ? 502 : 200);
        if (failure) expect(response.body.toString()).to.equal("original error");
        expect(logs[0][1].stages.upstream).to.be.at.least(100);
        const row = requestMetrics.drain().find(entry => entry.data.metric === "upstream").data;
        expect(row.count).to.equal(1); expect(row.errors).to.equal(Number(failure));
      } finally { Object.assign(storage, originals); }
    });
  }

  it("counts PID-owned network sockets without blocking the event loop", async function () {
    const listener = net.createServer(socket => socket.end()); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
    try {
      const snapshot = await socketSnapshot();
      if (process.platform === "linux") { expect(snapshot.listening).to.be.at.least(1); expect(snapshot.truncated).to.equal(false); }
    } finally { await new Promise(resolve => listener.close(resolve)); }
  });

  it("reports missing monitoring as unavailable", async function () {
    expect((await performanceReport(60000)).available).to.equal(false);
  });
});
