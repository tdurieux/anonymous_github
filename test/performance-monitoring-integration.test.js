const { expect } = require("chai");
const { createClient } = require("redis");
const net = require("node:net");
const { setTimeout } = require("node:timers");
require("ts-node/register/transpile-only");
const config = require("../src/config").default;
const { requestMetrics } = require("../src/core/request-monitoring");
const { startPerformanceMonitoring, flushPerformanceMetrics, performanceReport } = require("../src/core/performance-monitoring");
const port = Number(process.env.PERFORMANCE_REDIS_PORT);

(port ? describe : describe.skip)("request monitoring persistence", function () {
  this.timeout(15000);
  let stop, redis, previous;
  before(async function () {
    previous = { host: config.REDIS_HOSTNAME, port: config.REDIS_PORT };
    config.REDIS_HOSTNAME = "127.0.0.1"; config.REDIS_PORT = port;
    redis = createClient({ socket: { host: "127.0.0.1", port, reconnectStrategy: false } }); await redis.connect();
  });
  beforeEach(async function () {
    const keys = [];
    for await (const key of redis.scanIterator({ MATCH: "performance:v1:*" })) keys.push(key);
    if (keys.length) await redis.del(keys);
    requestMetrics.drain();
  });
  afterEach(async function () { if (stop) { await stop(); stop = null; } requestMetrics.drain(); });
  after(async function () { await redis.disconnect(); config.REDIS_HOSTNAME = previous.host; config.REDIS_PORT = previous.port; });
  async function start(service) {
    stop = startPerformanceMonitoring(service, () => ({ running: 0, waiting: 0 }));
    const deadline = Date.now() + 4000;
    while (!(await performanceReport(15)).available) {
      if (Date.now() > deadline) throw Error("Monitoring did not connect");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  it("batches latency, failures, interruptions and resource history with bounded retention", async function () {
    await start("api");
    requestMetrics.observe("request", "/api/repo/:repoId/zip", "GET", 8000, { bytes: 12345 });
    requestMetrics.observe("request", "/api/repo/:repoId/zip", "GET", 1500, { aborted: true, error: true });
    requestMetrics.observe("upstream", "all", "all", 90);
    await flushPerformanceMetrics();
    const result = await performanceReport(15);
    expect(result.available).to.equal(true); expect(result.routes).to.have.length(1);
    expect(result.routes[0]).to.include({ count: 2, aborted: 1, errors: 1, bytes: 12345, avgMs: 4750, p95UpperMs: 10000 });
    expect(result.stages[0]).to.include({ metric: "upstream", count: 1 });
    expect(result.instances).to.have.length(1); expect(result.instances[0].memory.rss).to.be.greaterThan(0);
    expect(result.runtimeSeries).to.have.length(1); expect(result.series[0].requests).to.equal(2);
    const minuteKey = `performance:v1:minute:api:${Math.floor(Date.now() / 60000) * 60000}`;
    expect(await redis.ttl(minuteKey)).to.be.within(7100, 7200);
    expect(await redis.ttl(`performance:v1:instance:${result.instances[0].instance}`)).to.be.within(80, 90);
    await flushPerformanceMetrics(); expect((await performanceReport(15)).routes[0].count).to.equal(2);
  });
  it("retains counters across process restarts and combines all streamers", async function () {
    await start("api"); requestMetrics.observe("request", "/api/repo/:repoId/file/:path", "GET", 20);
    await flushPerformanceMetrics(); await stop(); stop = null;
    await start("streamer"); requestMetrics.observe("request", "/api", "POST", 10); await flushPerformanceMetrics();
    const result = await performanceReport(60);
    expect(result.routes.map(row => row.service).sort()).to.deep.equal(["api", "streamer"]);
    expect(result.runtimeSeries.map(row => row.service).sort()).to.deep.equal(["api", "streamer"]);
    expect(result.windowMinutes).to.equal(60);
  });
  it("bounds requested history and excludes expired process heartbeats", async function () {
    await start("api"); await flushPerformanceMetrics();
    await redis.zAdd("performance:v1:instances", { score: Date.now() - 100000, value: "retired" });
    await redis.set("performance:v1:instance:retired", '{"instance":"retired"}');
    const result = await performanceReport(1000000);
    expect(result.windowMinutes).to.equal(15); expect(result.instances).to.have.length(1);
    expect(result.instances[0].instance).not.to.equal("retired");
  });
  it("returns unavailable promptly and stays bounded when the Redis endpoint never replies", async function () {
    const connections = [];
    const blackhole = net.createServer(socket => { connections.push(socket); socket.on("error", () => {}); });
    await new Promise(resolve => blackhole.listen(0, "127.0.0.1", resolve));
    config.REDIS_PORT = blackhole.address().port;
    try {
      stop = startPerformanceMonitoring("api");
      for (let i = 0; i < 10000; i++) requestMetrics.observe("request", "other", "GET", 10);
      const started = Date.now(); await flushPerformanceMetrics();
      expect((await performanceReport(60)).available).to.equal(false);
      expect(Date.now() - started).to.be.lessThan(500); expect(requestMetrics.size).to.equal(0);
      await stop(); stop = null;
    } finally {
      connections.forEach(socket => socket.destroy()); await new Promise(resolve => blackhole.close(resolve)); config.REDIS_PORT = port;
    }
  });
  it("cuts off an in-flight batch when a connected Redis server stops responding", async function () {
    await start("api");
    requestMetrics.observe("request", "other", "GET", 15);
    await redis.sendCommand(["CLIENT", "PAUSE", "2500", "ALL"]);
    const started = Date.now();
    await flushPerformanceMetrics();
    expect(Date.now() - started).to.be.within(1800, 2800);
    expect(requestMetrics.size).to.equal(0);
    expect((await performanceReport(15)).available).to.equal(false);
  });
});
