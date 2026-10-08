const { expect } = require("chai");
const process = require("node:process");
const { fork } = require("node:child_process");
const { promises: fs } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { S3, CreateBucketCommand } = require("@aws-sdk/client-s3");
const { createClient } = require("redis");
require("ts-node/register/transpile-only");
const config = require("../src/config").default;
const S3Storage = require("../src/core/storage/S3").default;
const GitHubStream = require("../src/core/source/GitHubStream").default;
const storage = require("../src/core/storage").default;
const { coordinatedFill, closeCacheRedis, cacheRedis } = require("../src/core/cache-coordination");
const { setTimeout: delay } = require("node:timers/promises");

(process.env.PERFORMANCE_REDIS_PORT ? describe : describe.skip)("disposable Redis cache coordination", function () {
  this.timeout(20000);
  let root, redis, previousRedis;
  before(async () => {
    await closeCacheRedis();
    root = await fs.mkdtemp(path.join(tmpdir(), "anonymous-cache-test-"));
    previousRedis = { REDIS_HOSTNAME: config.REDIS_HOSTNAME, REDIS_PORT: config.REDIS_PORT };
    config.REDIS_HOSTNAME = "127.0.0.1"; config.REDIS_PORT = Number(process.env.PERFORMANCE_REDIS_PORT);
    redis = createClient({ socket: { host: "127.0.0.1", port: config.REDIS_PORT } });
    await redis.connect();
  });
  after(async () => { await closeCacheRedis(); await redis.quit(); Object.assign(config, previousRedis); await fs.rm(root, { force: true, recursive: true }); });
  it("downloads and publishes once across two streamer processes and ten callers", async () => {
    let producers = 0;
    const children = Array.from({ length: 2 }, () => fork(path.join(__dirname, "fixtures/performance-cache-worker.js"), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env,
      FOLDER: root, REDIS_HOSTNAME: "127.0.0.1", REDIS_PORT: String(config.REDIS_PORT), NODE_ENV: "test" } }));
    try {
      const results = children.map(child => new Promise((resolve, reject) => {
        child.on("message", message => {
          if (message.ready) child.send("start");
          if (message.producer) producers++;
          if (message.contents) resolve(message.contents);
          if (message.error) reject(Error(message.error));
        });
        child.on("error", reject); child.on("exit", code => { if (code) reject(Error(`worker exited ${code}`)); });
      }));
      const contents = (await Promise.all(results)).flat();
      expect(contents).to.deep.equal(Array(10).fill("complete content"));
      expect(producers).to.equal(1);
    } finally { children.forEach(child => child.kill()); }
  });
  it("recovers an expired crashed-producer lease without publishing partial output", async () => {
    const key = `crash-test-${Date.now()}`;
    await redis.set(`perf:lease:${key}`, "dead-process", { PX: 150 });
    let value, producers = 0;
    const result = await coordinatedFill(key, async () => value, async () => { producers++; value = "verified"; return value; });
    expect(result).to.equal("verified"); expect(producers).to.equal(1);
    expect(await redis.get(`perf:lease:${key}`)).to.equal(null);
  });
  for (const failure of ["restart", "timeout"]) {
    it(`returns verified output despite a Redis heartbeat ${failure}`, async () => {
      await closeCacheRedis();
      const client = await cacheRedis(), originalEval = client.eval;
      let notify, published;
      const heartbeat = new Promise(resolve => { notify = resolve; });
      client.eval = function (script, options) {
        if (script.includes("pexpire")) {
          notify();
          return failure === "timeout" ? new Promise(() => {}) : Promise.reject(Error("Redis restarted"));
        }
        return originalEval.call(this, script, options);
      };
      const key = `heartbeat-${failure}-${Date.now()}`;
      try {
        const result = await coordinatedFill(key, async () => published, async () => {
          await heartbeat; await delay(failure === "timeout" ? 1100 : 20);
          published = "verified output"; return published;
        });
        expect(result).to.equal("verified output");
        expect(await coordinatedFill(key, async () => published, async () => published)).to.equal("verified output");
      } finally { client.eval = originalEval; await closeCacheRedis(); }
    });
  }
});

describe("S3 HTTP protocol integration", function () {
  this.timeout(20000);
  let backend, previous, client, fixture;
  before(async () => {
    previous = { ...config };
    if (!process.env.PERFORMANCE_S3_ENDPOINT) fixture = await require("./fixtures/s3-server")();
    Object.assign(config, { S3_BUCKET: "performance-test", S3_CLIENT_ID: "perf-test-user", S3_CLIENT_SECRET: "perf-test-password",
      S3_REGION: "us-east-1", S3_ENDPOINT: process.env.PERFORMANCE_S3_ENDPOINT || fixture.endpoint });
    client = new S3({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: true,
      credentials: { accessKeyId: config.S3_CLIENT_ID, secretAccessKey: config.S3_CLIENT_SECRET } });
    await client.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
    backend = new S3Storage();
  });
  after(async () => { client?.destroy(); for (const value of backend?.clients.values() || []) value.destroy(); Object.assign(config, previous); await fixture?.close(); });
  it("reuses clients and serves a warm file with one HEAD and one GET", async () => {
    await backend.write("s3repo", "file.txt", Readable.from([Buffer.from("complete content")]), undefined, 16);
    expect(backend.client(3000)).to.equal(backend.client(3000));
    let heads = 0, gets = 0;
    const common = backend.client(3000), oldHead = common.headObject.bind(common), oldSend = common.send.bind(common);
    common.headObject = (...args) => { heads++; return oldHead(...args); };
    common.send = (...args) => { if (args[0].constructor.name === "GetObjectCommand") gets++; return oldSend(...args); };
    const originals = { fileInfo: storage.fileInfo, read: storage.read, write: storage.write };
    try {
      storage.fileInfo = backend.fileInfo.bind(backend); storage.read = backend.read.bind(backend); storage.write = backend.write.bind(backend);
      const source = new GitHubStream({ repoId: "s3repo", organization: "owner", repoName: "repo", commit: "commit", getToken: () => { throw Error("warm cache requested token"); } });
      const input = await source.getFileContentCache("file.txt", "s3repo", () => ({ sha: "blob", size: 16 }));
      let text = ""; for await (const chunk of input) text += chunk;
      expect(text).to.equal("complete content"); expect(heads).to.equal(1); expect(gets).to.equal(1);
    } finally { Object.assign(storage, originals); }
  });
  it("refuses a short upload before committing the object", async () => {
    let error;
    try { await backend.write("s3repo", "short.txt", Readable.from([Buffer.from("short")]), undefined, 100); } catch (caught) { error = caught; }
    expect(error).to.be.instanceOf(Error);
    expect(await backend.exists("s3repo", "short.txt")).to.equal("not_found");
  });
  it("removes legacy S3 keys in bounded batches while retaining managed caches and other repositories", async function () {
    if (!fixture) this.skip();
    for (let i = 0; i < 1005; i++) fixture.seed(`legacy-s3/original/private/file-${String(i).padStart(4, "0")}.txt`, "obsolete");
    const active = require("../src/core/content-generation").contentGenerationPrefix("active");
    fixture.seed(`legacy-s3/original/${active}/blob/keep.txt`, "active");
    fixture.seed("legacy-s3-other/original/private/keep.txt", "keep");
    const before = fixture.requests.deletions.length;
    await backend.removeLegacyContent("legacy-s3");
    const batches = fixture.requests.deletions.slice(before);
    expect(batches).to.have.length(2);
    expect(batches.flat()).to.have.length(1005);
    expect(batches.every(batch => batch.length <= 1000)).to.equal(true);
    expect(await backend.exists("legacy-s3", "private/file-0000.txt")).to.equal("not_found");
    expect(await backend.exists("legacy-s3", "private/file-1004.txt")).to.equal("not_found");
    expect(await backend.exists("legacy-s3", `${active}/blob/keep.txt`)).to.equal("file");
    expect(await backend.exists("legacy-s3-other", "private/keep.txt")).to.equal("file");
  });
});
