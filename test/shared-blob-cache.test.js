const { strict: assert } = require("node:assert");
const { promises: fs } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Readable } = require("node:stream");
const { createHash, randomBytes } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { gunzipSync } = require("node:zlib");
require("ts-node/register/transpile-only");
const { BlobCache, CacheAdmissionError } = require("../src/core/blob-cache");
const config = require("../src/config").default;
const read = async stream => { const chunks = []; for await (const b of stream) chunks.push(Buffer.from(b)); return Buffer.concat(chunks); };
const digest = b => "git-" + createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");

describe("shared content-addressed blob pool", function () {
  this.timeout(10000);
  let root, cache, oldMonitoring;
  beforeEach(async () => { oldMonitoring = config.CACHE_MONITORING_ENABLED; config.CACHE_MONITORING_ENABLED = false;
    root = await fs.mkdtemp(join(tmpdir(), "shared-blob-test-"));
    cache = new BlobCache({ root, budget: 65536, maxObject: 4096, gzip: true }); });
  afterEach(async () => { cache.close(); config.CACHE_MONITORING_ENABLED = oldMonitoring; await fs.rm(root, { recursive: true, force: true }); });
  it("stores one verified blob across project aliases and independently reads gzip and identity", async () => {
    const b = Buffer.from("shared text\n".repeat(300));
    const verify = async p => { assert.equal("git-" + p.gitSha, digest(b)); return digest(b); };
    assert.deepEqual(await read(await cache.getOrFill("project-a", async () => Readable.from(b), verify)), b);
    assert.deepEqual(await read(await cache.getOrFill("project-b", async () => Readable.from(b), verify)), b);
    assert.equal(cache.stats().blobs, 1); assert.ok(cache.stats().storedBytes < b.length / 2);
    assert.deepEqual(gunzipSync(await read(await cache.open(digest(b), true))), b);
    assert.deepEqual(await read(await cache.lookup("project-a")), b);
  });
  it("keeps summary counters exact across connections, replacement, rollback and migration", async () => {
    const check = store => {
      const expected = store.db.prepare(`SELECT COUNT(*) blobs,COALESCE(SUM(size),0) originalBytes,
        COALESCE(SUM(stored),0) storedBytes,COALESCE(SUM(allocated),0) allocatedBytes,
        (SELECT COUNT(*) FROM readers) activeReaders,(SELECT COUNT(*) FROM decisions) decisions,
        (SELECT COUNT(*) FROM aliases) aliases,(SELECT COUNT(*) FROM history) history,
        (SELECT COALESCE(SUM(reserved),0) FROM fills) reservedBytes FROM blobs`).get();
      const actual = store.db.prepare("SELECT * FROM summary WHERE id=1").get();
      for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, key);
    };
    const stream = await cache.getOrFill("counter-a", async () => Readable.from("same content"));
    check(cache);
    const other = new BlobCache(cache.options);
    try {
      await read(await other.getOrFill("counter-b", async () => Readable.from("same content")));
      other.saveDecision("rule", stream.cachedBlob.record.digest, false);
      other.saveDecision("rule", stream.cachedBlob.record.digest, true);
      check(cache); check(other);
      other.db.exec("BEGIN; INSERT OR REPLACE INTO history VALUES('counter-a',0,1); DELETE FROM decisions; ROLLBACK;");
      check(cache);
      await read(stream); await delay(20); check(other);
      other.db.prepare("DELETE FROM blobs").run(); check(cache);
    } finally { other.close(); }
    // Simulate an index created before the summary migration.
    for (const row of cache.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'summary_%'").all())
      cache.db.exec('DROP TRIGGER "' + row.name + '"');
    cache.db.exec("DROP TABLE summary");
    cache.close(); cache = new BlobCache(cache.options); check(cache);
  });
  it("upgrades old decisions without inventing a sniffed content classification", () => {
    cache.saveDecision("old", "git-" + "a".repeat(40), false);
    cache.db.exec("ALTER TABLE decisions DROP COLUMN isText");
    cache.close(); cache = new BlobCache(cache.options);
    assert.equal(cache.decision("old").isText, undefined);
    cache.saveDecision("old", "git-" + "a".repeat(40), false, true);
    assert.equal(cache.decision("old").isText, true);
    assert.equal(cache.stats().decisions, 1);
  });
  it("uses durable commits for reservations and publication while keeping hit bookkeeping disposable", async () => {
    assert.equal(cache.db.prepare("PRAGMA synchronous").get().synchronous, 1);
    const original = cache.db.exec.bind(cache.db), commits = [];
    cache.db.exec = sql => {
      if (sql === "COMMIT") commits.push(Number(cache.db.prepare("PRAGMA synchronous").get().synchronous));
      return original(sql);
    };
    await read(await cache.getOrFill("durability", async () => Readable.from("durable bytes")));
    assert.equal(commits.filter(x => x === 2).length, 3);
    commits.length = 0;
    await read(await cache.getOrFill("durability", async () => { throw Error("unexpected miss"); }));
    assert.ok(commits.length > 0); assert.ok(commits.every(x => x === 1));
    cache.options.budget = 1;
    await assert.rejects(cache.getOrFill("no-space", async () => Readable.from("x")), CacheAdmissionError);
    assert.equal(cache.db.prepare("PRAGMA synchronous").get().synchronous, 1);
  });
  it("coalesces fills across independent index connections", async () => {
    const other = new BlobCache(cache.options); let calls = 0;
    try {
      const produce = async () => { calls++; await delay(50); return Readable.from("complete output"); };
      const streams = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? other : cache).getOrFill("same", produce)));
      const values = await Promise.all(streams.map(read)); assert.equal(calls, 1);
      assert.ok(values.every(b => b.toString() === "complete output"));
    } finally { other.close(); }
  });
  it("coalesces fills across separate operating-system processes", async function () {
    this.timeout(45000);
    const { fork } = require("node:child_process");
    const workers = [0, 1].map(() => fork(join(__dirname, "fixtures/shared-cache-worker.js"), [], {
      env: { ...process.env, NODE_ENV: "test", BLOB_TEST_OPTIONS: JSON.stringify(cache.options) }, stdio: ["ignore", "ignore", "pipe", "ipc"]
    }));
    let fills = 0;
    const readiness = workers.map(worker => new Promise((resolve, reject) => {
      let stderr = "";
      worker.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
      worker.on("message", message => { if (message === "ready") resolve(); });
      worker.on("error", reject);
      worker.on("exit", code => reject(Error(`worker exited ${code}: ${stderr}`)));
    }));
    try {
      const results = workers.map(worker => new Promise((resolve, reject) => {
        worker.on("message", message => {
          if (message === "fill") fills++;
          if (message.error) reject(Error(message.error));
          if (message.body) resolve(message.body);
        });
        worker.on("error", reject);
        worker.on("exit", code => { if (code) reject(Error("worker exited " + code)); });
      }));
      await Promise.all(readiness);
      workers.forEach(worker => worker.send("start"));
      assert.deepEqual(await Promise.all(results), ["shared across processes", "shared across processes"]);
      assert.equal(fills, 1); assert.equal(cache.stats().blobs, 1);
    } finally { workers.forEach(worker => worker.kill()); }
  });
  it("recovers a producer killed after rename without losing its disk reservation", async function () {
    this.timeout(45000);
    const { fork } = require("node:child_process");
    const worker = fork(join(__dirname, "fixtures/shared-cache-worker.js"), [], {
      env: { ...process.env, NODE_ENV: "test", BLOB_TEST_OPTIONS: JSON.stringify(cache.options), BLOB_TEST_CRASH_AFTER_RENAME: "1" },
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    try {
      const renamed = await new Promise((resolve, reject) => {
        let stderr = "";
        worker.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
        worker.on("error", reject);
        worker.on("exit", code => reject(Error("premature exit " + code + ": " + stderr)));
        worker.on("message", message => {
          if (message === "ready") worker.send("start");
          if (message.renamed) resolve(message.renamed);
          if (message.error) reject(Error(message.error));
        });
      });
      const exited = new Promise(resolve => worker.once("exit", resolve));
      worker.kill("SIGKILL"); await exited;
      assert.ok(cache.stats().reservedBytes > 0);
      assert.equal(cache.stats().blobs, 0);
      assert.equal(cache.db.prepare("SELECT COUNT(*) n FROM publications").get().n, 1);
      await fs.access(renamed);
      cache.db.exec("UPDATE fills SET expires=1");
      await cache.maintain();
      await assert.rejects(fs.access(renamed), { code: "ENOENT" });
      assert.equal(cache.stats().reservedBytes, 0);
      assert.equal(cache.db.prepare("SELECT COUNT(*) n FROM publications").get().n, 0);
      assert.equal((await read(await cache.getOrFill("multiprocess", async () => Readable.from("recovered")))).toString(), "recovered");
    } finally { worker.kill(); }
  });
  it("pins a duplicate publication while another connection tries to evict it", async () => {
    await read(await cache.getOrFill("original", async () => Readable.from("identical")));
    const other = new BlobCache({ ...cache.options, budget: 8192, maxObject: 1024 });
    const unlink = fs.unlink.bind(fs); let competed = false;
    fs.unlink = async path => {
      if (!competed && path.includes("/blobs/") && !cache.db.prepare("SELECT 1 FROM blobs WHERE file=?").get(require("node:path").basename(path))) {
        competed = true;
        await assert.rejects(other.getOrFill("competitor", async () => Readable.from("different")), CacheAdmissionError);
      }
      return unlink(path);
    };
    try {
      assert.equal((await read(await cache.getOrFill("duplicate", async () => Readable.from("identical")))).toString(), "identical");
      assert.ok(competed);
      await delay(20); assert.equal(cache.stats().activeReaders, 0);
    } finally { fs.unlink = unlink; other.close(); }
  });
  it("turns SQLite write contention into a cache bypass and preserves existing data", async () => {
    await read(await cache.getOrFill("locked", async () => Readable.from("available")));
    const other = new BlobCache(cache.options);
    other.db.exec("BEGIN IMMEDIATE");
    try {
      await assert.rejects(cache.getOrFill("locked", async () => { throw Error("unexpected fill"); }),
        error => error instanceof CacheAdmissionError && error.message === "cache_index_busy");
    } finally { other.db.exec("ROLLBACK"); other.close(); }
    assert.equal((await read(await cache.lookup("locked"))).toString(), "available");
    await delay(20); assert.equal(cache.stats().activeReaders, 0);
  });
  it("does not publish failed or hash-invalid fills and releases reservations", async () => {
    await assert.rejects(cache.getOrFill("invalid", async () => Readable.from("bad"), async () => { throw Error("invalid_hash"); }), /invalid_hash/);
    assert.equal(cache.stats().blobs, 0); assert.equal(cache.stats().reservedBytes, 0);
    assert.deepEqual(await fs.readdir(join(root, "tmp")), []);
    await assert.rejects(cache.getOrFill("large", async () => Readable.from(Buffer.alloc(5000))), CacheAdmissionError);
    assert.equal(cache.stats().reservedBytes, 0);
  });
  it("evicts least-recently-read data while retaining active readers and respecting the budget", async () => {
    const data = randomBytes(4000);
    for (let i = 0; i < 12; i++) { const b = Buffer.concat([Buffer.from([i]), data]); await read(await cache.getOrFill("file" + i, async () => Readable.from(b))); }
    const pinned = await cache.lookup("file0"); assert.ok(pinned);
    const pinnedDigest = pinned.cachedBlob.record.digest;
    cache.db.prepare("UPDATE blobs SET accessed=1 WHERE digest<>?").run(pinnedDigest);
    for (let i = 12; i < 20; i++) { const b = Buffer.concat([Buffer.from([i]), data]); await read(await cache.getOrFill("file" + i, async () => Readable.from(b))); }
    assert.ok(cache.stats().storedBytes + cache.stats().reservedBytes <= cache.options.budget);
    assert.ok(cache.db.prepare("SELECT 1 FROM blobs WHERE digest=?").get(pinnedDigest));
    assert.equal((await read(pinned)).length, 4001);
    assert.equal(await cache.lookup("file1"), undefined);
    assert.deepEqual(await read(await cache.getOrFill("file1", async () => Readable.from("refetched"))), Buffer.from("refetched"));
  });
  it("recovers an expired producer and removes its temporary files before admitting new work", async () => {
    cache.db.prepare("INSERT INTO fills VALUES(?,?,?,?)").run("dead", "dead", 1, 60000);
    await fs.writeFile(join(root, "tmp", "dead.raw"), "partial");
    const orphanDigest = "sha256-" + "a".repeat(64);
    const orphanDir = join(root, "blobs", "aa", orphanDigest);
    await fs.mkdir(orphanDir, { recursive: true }); await fs.writeFile(join(orphanDir, "dead.raw"), "unindexed");
    cache.db.prepare("INSERT INTO publications VALUES(?,?,?)").run("dead", orphanDigest, "dead.raw");
    await read(await cache.getOrFill("new", async () => Readable.from("new")));
    assert.equal(cache.stats().reservedBytes, 0); assert.deepEqual(await fs.readdir(join(root, "tmp")), []);
    assert.deepEqual(await fs.readdir(orphanDir), []);
  });
  it("invalidates a missing or truncated file and refetches it", async () => {
    const stream = await cache.getOrFill("missing", async () => Readable.from("hello"));
    const record = stream.cachedBlob.record; await read(stream);
    const p = join(root, "blobs", record.digest.split("-")[1].slice(0, 2), record.digest, record.file);
    await fs.writeFile(p, "x"); assert.equal(await cache.lookup("missing"), undefined);
    assert.deepEqual(await read(await cache.getOrFill("missing", async () => Readable.from("hello"))), Buffer.from("hello"));
  });
  it("bounds decision retention and expires old transformation settings", () => {
    cache.saveDecision("rule-v1", "git-" + "a".repeat(40), false);
    assert.equal(cache.decision("rule-v1").changed, false); assert.equal(cache.decision("rule-v2"), undefined);
    cache.db.prepare("UPDATE decisions SET expires=1").run(); assert.equal(cache.decision("rule-v1"), undefined);
  });
});
