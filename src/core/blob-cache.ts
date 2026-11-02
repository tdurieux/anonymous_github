import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "crypto";
import { createReadStream, createWriteStream, mkdirSync, unlinkSync, rmdirSync, statfsSync, promises as fs } from "fs";
import { join } from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { createGzip, createGunzip } from "zlib";
import { performance } from "perf_hooks";
import config from "../config";
import { observeCache } from "./cache-observability";

export class CacheAdmissionError extends Error {}
export function isCacheContention(error: unknown) {
  const code = Number((error as { errcode?: number })?.errcode) & 255;
  return code === 5 || code === 6;
}
function cacheError(error: unknown): never {
  if (isCacheContention(error)) throw new CacheAdmissionError("cache_index_busy");
  throw error;
}
export interface BlobRecord { digest: string; file: string; size: number; stored: number; allocated: number; encoding: "gzip" | "identity"; accessed: number }
export interface BlobProof { gitSha: string; sha256: string; size: number }
export interface BlobOptions { root: string; budget: number; maxObject: number; gzip?: boolean; saving?: number; freeBytes?: number; lowWater?: number; name?: string; reservationRoot?: string }
export type BlobStream = Readable & { cachedBlob?: { store: BlobCache; record: BlobRecord } };
const validDigest = (s: string) => /^(git-[a-f0-9]{40}|sha256-[a-f0-9]{64})$/.test(s);

/** One local filesystem shared by all processes. SQLite WAL coordinates metadata, fills and reader leases. */
export class BlobCache {
  readonly db: DatabaseSync;
  readonly name: string;
  private disk?: DatabaseSync;
  constructor(readonly options: BlobOptions) {
    if (!(options.budget > 0 && options.maxObject > 0)) throw new Error("invalid_cache_budget");
    this.name = options.name || "source";
    mkdirSync(join(options.root, "tmp"), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(options.root, "index.sqlite"));
    try {
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS blobs(digest TEXT PRIMARY KEY,file TEXT,size INTEGER,stored INTEGER,encoding TEXT,accessed INTEGER,allocated INTEGER);
        CREATE INDEX IF NOT EXISTS blobs_lru ON blobs(accessed);
        CREATE TABLE IF NOT EXISTS aliases(key TEXT PRIMARY KEY,digest TEXT REFERENCES blobs(digest) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS aliases_digest ON aliases(digest);
        CREATE TABLE IF NOT EXISTS fills(key TEXT PRIMARY KEY,token TEXT,expires INTEGER,reserved INTEGER);
        CREATE TABLE IF NOT EXISTS publications(token TEXT PRIMARY KEY,digest TEXT,file TEXT);
        CREATE TABLE IF NOT EXISTS readers(token TEXT PRIMARY KEY,digest TEXT,expires INTEGER);
        CREATE INDEX IF NOT EXISTS readers_digest ON readers(digest);
        CREATE INDEX IF NOT EXISTS readers_expiry ON readers(expires);
        CREATE TABLE IF NOT EXISTS decisions(key TEXT PRIMARY KEY,digest TEXT,changed INTEGER,accessed INTEGER,expires INTEGER);
        CREATE INDEX IF NOT EXISTS decisions_age ON decisions(accessed);
        CREATE INDEX IF NOT EXISTS decisions_expiry ON decisions(expires);
        CREATE TABLE IF NOT EXISTS maintenance(id INTEGER PRIMARY KEY,nextScan INTEGER);
        CREATE TABLE IF NOT EXISTS history(key TEXT PRIMARY KEY,seen INTEGER,evicted INTEGER);
        CREATE INDEX IF NOT EXISTS history_seen ON history(seen);
        CREATE INDEX IF NOT EXISTS blobs_file ON blobs(file);
        CREATE TABLE IF NOT EXISTS totals(id INTEGER PRIMARY KEY, bytes INTEGER);
        CREATE TRIGGER IF NOT EXISTS blob_added AFTER INSERT ON blobs BEGIN UPDATE totals SET bytes=bytes+NEW.allocated WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS blob_removed AFTER DELETE ON blobs BEGIN UPDATE totals SET bytes=bytes-OLD.allocated WHERE id=1; END;
        PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON;`);
      // Initialize once under a write lock; all connections see data and counters atomically.
      this.transaction(() => {
        // Classification is nullable for decisions written by older versions.
        if (!this.db.prepare("PRAGMA table_info(decisions)").all().some(row => row.name === "isText"))
          this.db.exec("ALTER TABLE decisions ADD COLUMN isText INTEGER");
        if (!this.db.prepare("SELECT 1 FROM totals WHERE id=1").get()) this.db.exec("INSERT INTO totals SELECT 1,COALESCE(SUM(allocated),0) FROM blobs");
        this.db.exec(`CREATE TABLE IF NOT EXISTS summary(id INTEGER PRIMARY KEY,blobs INTEGER,originalBytes INTEGER,storedBytes INTEGER,allocatedBytes INTEGER,activeReaders INTEGER,decisions INTEGER,aliases INTEGER,history INTEGER,reservedBytes INTEGER)`);
        if (!this.db.prepare("SELECT 1 FROM summary WHERE id=1").get()) {
          this.db.exec(`INSERT INTO summary SELECT 1,COUNT(*),COALESCE(SUM(size),0),COALESCE(SUM(stored),0),COALESCE(SUM(allocated),0),
            (SELECT COUNT(*) FROM readers),(SELECT COUNT(*) FROM decisions),(SELECT COUNT(*) FROM aliases),(SELECT COUNT(*) FROM history),(SELECT COALESCE(SUM(reserved),0) FROM fills) FROM blobs`);
        }
        for (const [table, columns] of [
          ["blobs", { blobs: "1", originalBytes: "size", storedBytes: "stored", allocatedBytes: "allocated" }],
          ["readers", { activeReaders: "1" }], ["decisions", { decisions: "1" }],
          ["aliases", { aliases: "1" }], ["history", { history: "1" }], ["fills", { reservedBytes: "reserved" }]
        ] as [string, Record<string, string>][]) {
          const changes = (prefix: string, sign: string) => Object.entries(columns).map(([column, value]) =>
            `${column}=${column}${sign}${value === "1" ? "1" : prefix + "." + value}`).join(",");
          this.db.exec(`CREATE TRIGGER IF NOT EXISTS summary_${table}_insert AFTER INSERT ON ${table} BEGIN UPDATE summary SET ${changes("NEW", "+")} WHERE id=1; END;
            CREATE TRIGGER IF NOT EXISTS summary_${table}_delete AFTER DELETE ON ${table} BEGIN UPDATE summary SET ${changes("OLD", "-")} WHERE id=1; END;`);
          const values = Object.entries(columns).filter(([, value]) => value !== "1");
          if (values.length) this.db.exec(`CREATE TRIGGER IF NOT EXISTS summary_${table}_update AFTER UPDATE OF ${values.map(([, value]) => value).join(",")} ON ${table}
            BEGIN UPDATE summary SET ${values.map(([column, value]) => `${column}=${column}-OLD.${value}+NEW.${value}`).join(",")} WHERE id=1; END;`);
        }
      });
      const reservationRoot = options.reservationRoot || options.root;
      mkdirSync(reservationRoot, { recursive: true, mode: 0o700 });
      this.disk = new DatabaseSync(join(reservationRoot, "disk-reservations.sqlite"));
      this.disk.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS reservations(token TEXT PRIMARY KEY,bytes INTEGER);
        PRAGMA busy_timeout=50;`);
      this.db.exec("PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=50;");
    } catch (error) { this.disk?.close(); this.db.close(); throw error; }
  }
  // Reader leases, history and decisions are disposable after a system failure.
  // Reservations and publication records use FULL before creating/renaming payloads,
  // so recovery never releases disk accounting before removing an unindexed file.
  private transaction<T>(fn: () => T, durable = false): T {
    if (durable) this.db.exec("PRAGMA synchronous=FULL");
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try { const value = fn(); this.db.exec("COMMIT"); return value; }
      catch (error) { this.db.exec("ROLLBACK"); throw error; }
    } finally { if (durable) this.db.exec("PRAGMA synchronous=NORMAL"); }
  }
  private trim(table: "aliases" | "history" | "decisions", limit: number, order: string) {
    const excess = Number(this.db.prepare(`SELECT ${table} n FROM summary WHERE id=1`).get()!.n) - limit;
    if (excess > 0) this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY ${order} LIMIT ?)`).run(excess);
  }
  private reserveDisk(token: string, bytes: number) {
    const disk = this.disk!;
    disk.exec("BEGIN IMMEDIATE");
    try {
      // Take a fresh filesystem sample while holding the shared admission lock.
      const space = statfsSync(this.options.root);
      const pending = Number(disk.prepare("SELECT COALESCE(SUM(bytes),0) bytes FROM reservations").get()!.bytes);
      if (space.bavail * space.bsize < pending + bytes + (this.options.freeBytes || 0))
        throw new CacheAdmissionError("disk_headroom");
      disk.prepare("INSERT INTO reservations VALUES(?,?)").run(token, bytes);
      disk.exec("COMMIT");
    } catch (error) { disk.exec("ROLLBACK"); throw error; }
  }
  private releaseDisk(token: string) { this.disk!.prepare("DELETE FROM reservations WHERE token=?").run(token); }
  private metric(event: string, bytes = 0, ms = 0) { observeCache(`${this.name}_${event}`, bytes, ms); }
  private path(record: BlobRecord) {
    if (!validDigest(record.digest) || !/^[a-f0-9-]+\.(gz|raw)$/.test(record.file)) throw new Error("invalid_blob_record");
    return join(this.options.root, "blobs", record.digest.substring(record.digest.indexOf("-") + 1, record.digest.indexOf("-") + 3), record.digest, record.file);
  }
  private usage() { return Number(this.db.prepare("SELECT allocatedBytes bytes FROM summary WHERE id=1").get()!.bytes); }
  private reservations() { return Number(this.db.prepare("SELECT reservedBytes bytes FROM summary WHERE id=1").get()!.bytes); }
  private expire() {
    const now = Date.now();
    // A crashed producer's files are removed BEFORE its reservation is released.
    const dead = this.db.prepare("SELECT token FROM fills WHERE expires<?").all(now);
    for (const row of dead) {
      const pending = this.db.prepare("SELECT digest,file FROM publications WHERE token=?").get(row.token);
      if (pending && !this.db.prepare("SELECT 1 FROM blobs WHERE file=?").get(pending.file)) {
        try { unlinkSync(this.path(pending as unknown as BlobRecord)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      this.db.prepare("DELETE FROM publications WHERE token=?").run(row.token);
      for (const suffix of ["raw", "gz"]) {
        try { unlinkSync(join(this.options.root, "tmp", `${row.token}.${suffix}`)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      this.releaseDisk(String(row.token));
    }
    this.db.prepare("DELETE FROM fills WHERE expires<?").run(now);
    this.db.prepare("DELETE FROM readers WHERE expires<?").run(now);
    this.db.prepare("DELETE FROM decisions WHERE rowid IN (SELECT rowid FROM decisions WHERE expires<? ORDER BY expires LIMIT 256)").run(now);
    this.db.prepare("DELETE FROM history WHERE rowid IN (SELECT rowid FROM history WHERE seen<? ORDER BY seen LIMIT 256)").run(now - 7 * 86400000);
  }
  private evictTo(target: number) {
    let used = this.usage();
    const rows = this.db.prepare(`SELECT * FROM blobs WHERE digest NOT IN (SELECT digest FROM readers)
      ORDER BY accessed LIMIT 512`).all() as unknown as BlobRecord[];
    for (const record of rows) {
      if (used <= target) break;
      try { unlinkSync(this.path(record)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue; }
      this.db.prepare("UPDATE history SET evicted=1 WHERE key IN (SELECT key FROM aliases WHERE digest=?)").run(record.digest);
      this.db.prepare("DELETE FROM blobs WHERE digest=?").run(record.digest);
      try { rmdirSync(join(this.path(record), "..")); } catch { /* another representation remains */ }
      used -= record.allocated; this.metric("eviction", record.stored, Date.now() - record.accessed);
    }
  }
  async maintain() {
    this.transaction(() => { this.expire(); this.evictTo(Math.max(0, this.options.budget - this.reservations())); });
    const scan = this.transaction(() => {
      const previous = this.db.prepare("SELECT nextScan FROM maintenance WHERE id=1").get();
      if (previous && Number(previous.nextScan) > Date.now()) return false;
      this.db.prepare("INSERT OR REPLACE INTO maintenance VALUES(1,?)").run(Date.now() + 3600000);
      return true;
    });
    if (!scan) return;
    // Recover publication orphans after crashes. Never remove a recent publisher's file.
    const walk = async (directory: string): Promise<void> => {
      let entries; try { entries = await fs.opendir(directory); } catch { return; }
      for await (const entry of entries) {
        const p = join(directory, entry.name);
        if (entry.isDirectory()) { await walk(p); continue; }
        const stat = await fs.stat(p).catch(() => undefined);
        if (!stat || Date.now() - stat.mtimeMs < 3600000) continue;
        const found = this.db.prepare("SELECT 1 FROM blobs WHERE file=?").get(entry.name);
        if (!found) await fs.unlink(p).catch(() => {});
      }
    };
    await walk(join(this.options.root, "blobs"));
  }
  stats() {
    const data = this.db.prepare("SELECT blobs,originalBytes,storedBytes,allocatedBytes,activeReaders,decisions,reservedBytes FROM summary WHERE id=1").get();
    return { ...data, budgetBytes: this.options.budget, maxObjectBytes: this.options.maxObject,
      oldestAccess: this.db.prepare("SELECT accessed FROM blobs ORDER BY accessed LIMIT 1").get()?.accessed ?? null };
  }
  async open(digest: string, encoded = false): Promise<BlobStream | undefined> {
    try { return await this.openReader(digest, encoded); } catch (error) { return cacheError(error); }
  }
  private async openReader(digest: string, encoded = false): Promise<BlobStream | undefined> {
    if (!validDigest(digest)) return;
    const token = randomUUID();
    let leaseUntil = Date.now() + 120000;
    const record = this.transaction(() => {
      const r = this.db.prepare("SELECT * FROM blobs WHERE digest=?").get(digest) as unknown as BlobRecord | undefined;
      if (!r) return;
      this.db.prepare("INSERT INTO readers VALUES(?,?,?)").run(token, digest, leaseUntil);
      if (Date.now() - r.accessed > 30000) this.db.prepare("UPDATE blobs SET accessed=? WHERE digest=?").run(Date.now(), digest);
      return r;
    });
    if (!record) return;
    let handle;
    try {
      handle = await fs.open(this.path(record), "r");
      if ((await handle.stat()).size !== record.stored) throw new Error("corrupt_blob_size");
    } catch {
      await handle?.close();
      await fs.unlink(this.path(record)).catch(() => {});
      this.db.prepare("DELETE FROM readers WHERE token=?").run(token);
      this.transaction(() => { this.db.prepare("DELETE FROM blobs WHERE digest=?").run(digest); });
      this.metric("corrupt"); return;
    }
    const source = handle.createReadStream();
    const needsDecode = record.encoding === "gzip" && !encoded;
    const output = (needsDecode ? createGunzip() : source) as BlobStream;
    output.cachedBlob = { store: this, record };
    let start = performance.now();
    let renewAt = Date.now() + 30000;
    const heartbeat = setInterval(() => {
      const now = Date.now();
      if (now < renewAt) return;
      if (now >= leaseUntil) { output.destroy(new Error("cache_reader_lease_lost")); return; }
      try {
        const renewedUntil = now + 120000;
        if (!this.db.prepare("UPDATE readers SET expires=? WHERE token=? AND expires>?").run(renewedUntil, token, now).changes) {
          output.destroy(new Error("cache_reader_lease_lost")); return;
        }
        leaseUntil = renewedUntil; renewAt = now + 30000;
      } catch (error) {
        if (!isCacheContention(error)) output.destroy(new Error("cache_reader_lease_lost"));
        // Retry on the next tick while the previously confirmed lease is valid.
      }
    }, 1000); heartbeat.unref();
    let released = false;
    const release = () => {
      if (released) return; released = true; clearInterval(heartbeat); source.destroy();
      try { this.db.prepare("DELETE FROM readers WHERE token=?").run(token); } catch { /* expires */ }
    };
    output.once("close", release);
    if (needsDecode) {
      // Delay decompression until a consumer asks for data; fast-path callers can close unused streams.
      const originalRead = output._read.bind(output); let begun = false;
      output._read = size => { if (!begun) { begun = true; start = performance.now(); source.on("error", e => output.destroy(e)); source.pipe(output as Transform); } originalRead(size); };
      output.once("end", () => observeCache("decompress", record.size, performance.now() - start));
    }
    return output;
  }
  async lookup(key: string): Promise<BlobStream | undefined> {
    const alias = this.db.prepare("SELECT digest FROM aliases WHERE key=?").get(key);
    return this.open(String(alias?.digest || key));
  }
  private accessed(key: string, hit: boolean, bytes = 0) {
    const previous = this.db.prepare("SELECT * FROM history WHERE key=? AND seen>=?").get(key, Date.now() - 7 * 86400000);
    this.metric(hit ? "hit" : "miss", bytes);
    if (!hit) this.metric(previous?.evicted ? "refetch" : previous ? "known_miss" : "first_seen_miss");
    if (previous) {
      const age = Date.now() - Number(previous.seen);
      for (const [label, limit] of [["1h", 3600000], ["1d", 86400000], ["7d", 604800000]] as const) if (age <= limit) this.metric(`reuse_${label}`, bytes);
    }
    if (!previous || previous.evicted || Date.now() - Number(previous.seen) >= 30000) this.transaction(() => {
      this.db.prepare("INSERT INTO history VALUES(?,?,0) ON CONFLICT(key) DO UPDATE SET seen=excluded.seen,evicted=0").run(key, Date.now());
      this.trim("history", 100000, "seen");
    });
  }
  async getOrFill(key: string, produce: () => Promise<Readable>, verify?: (proof: BlobProof) => Promise<string>, sizeHint?: number): Promise<BlobStream> {
    try { return await this.fill(key, produce, verify, sizeHint); } catch (error) { return cacheError(error); }
  }
  private async fill(key: string, produce: () => Promise<Readable>, verify?: (proof: BlobProof) => Promise<string>, sizeHint?: number): Promise<BlobStream> {
    if (!/^[a-z0-9-]{1,100}$/.test(key)) throw new Error("invalid_cache_key");
    let hit = await this.lookup(key);
    try { this.accessed(key, !!hit, hit?.cachedBlob?.record.size || sizeHint || 0); }
    catch (error) { hit?.destroy(); throw error; }
    if (hit) return hit;
    if (sizeHint != null && sizeHint > this.options.maxObject) { this.metric("bypass", sizeHint); throw new CacheAdmissionError("object_too_large"); }
    const token = randomUUID(), reservation = this.options.maxObject * 3 + 1024;
    const deadline = Date.now() + 120000;
    for (;;) {
      const owned = this.transaction(() => {
        this.expire();
        if (this.db.prepare("SELECT 1 FROM fills WHERE key=?").get(key)) return false;
        const reserved = this.reservations();
        if (this.usage() + reserved + reservation > this.options.budget) {
          this.evictTo(Math.max(0, Math.min(this.options.budget * (this.options.lowWater ?? 0.9), this.options.budget - reserved - reservation)));
        }
        if (this.usage() + reserved + reservation > this.options.budget) throw new CacheAdmissionError("cache_budget_busy");
        this.db.prepare("INSERT INTO fills VALUES(?,?,?,?)").run(key, token, Date.now() + 120000, reservation); return true;
      }, true);
      if (owned) break;
      this.metric("fill_wait");
      if (Date.now() >= deadline) throw new CacheAdmissionError("fill_timeout");
      await new Promise(resolve => setTimeout(resolve, 50));
      hit = await this.lookup(key); if (hit) return hit;
    }
    const raw = join(this.options.root, "tmp", `${token}.raw`), gz = join(this.options.root, "tmp", `${token}.gz`);
    let input: Readable | undefined, file: string | undefined;
    const heartbeat = setInterval(() => {
      try { if (!this.db.prepare("UPDATE fills SET expires=? WHERE key=? AND token=?").run(Date.now() + 120000, key, token).changes) input?.destroy(new Error("cache_fill_lease_lost")); }
      catch { input?.destroy(new Error("cache_fill_lease_lost")); }
    }, 30000); heartbeat.unref();
    const timeout = setTimeout(() => input?.destroy(new Error("cache_fill_timeout")), 120000); timeout.unref();
    try {
      // The pool reservation is already durable before acquiring physical headroom.
      this.transaction(() => {
        if (!this.db.prepare("SELECT 1 FROM fills WHERE token=? AND expires>?").get(token, Date.now())) throw new CacheAdmissionError("cache_fill_lease_lost");
        this.reserveDisk(token, reservation);
      });
      // Recheck after ownership; another producer may have published between the initial lookup and lease acquisition.
      hit = await this.lookup(key); if (hit) return hit;
      input = await produce();
      let size = 0; const sha256 = createHash("sha256");
      await pipeline(input, new Transform({ transform: (chunk, _encoding, done) => {
        size += chunk.length; sha256.update(chunk);
        done(size > this.options.maxObject ? new CacheAdmissionError("object_too_large") : null, chunk);
      } }), createWriteStream(raw, { flags: "wx", mode: 0o600 }));
      const git = createHash("sha1").update(`blob ${size}\0`);
      for await (const chunk of createReadStream(raw)) git.update(chunk);
      const proof = { gitSha: git.digest("hex"), sha256: sha256.digest("hex"), size };
      const digest = verify ? await verify(proof) : `sha256-${proof.sha256}`;
      if (!validDigest(digest)) throw new Error("invalid_verified_digest");
      let encoding: "gzip" | "identity" = "identity", stored = size, chosen = raw;
      if (this.options.gzip && size >= 1024) {
        const started = performance.now();
        await pipeline(createReadStream(raw), createGzip({ level: 6 }), createWriteStream(gz, { flags: "wx", mode: 0o600 }));
        const compressed = (await fs.stat(gz)).size;
        observeCache("compress", size, performance.now() - started);
        if (compressed <= size * (1 - (this.options.saving ?? 0.1))) { encoding = "gzip"; stored = compressed; chosen = gz; }
      }
      const record: BlobRecord = { digest, file: `${token}.${encoding === "gzip" ? "gz" : "raw"}`, size, stored, allocated: 0, encoding, accessed: Date.now() };
      file = this.path(record); await fs.mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
      const durable = await fs.open(chosen, "r");
      try { await durable.sync(); } finally { await durable.close(); }
      this.transaction(() => { this.db.prepare("INSERT INTO publications VALUES(?,?,?)").run(token, digest, record.file); }, true);
      await fs.rename(chosen, file);
      record.allocated = Math.max(4096, (await fs.stat(file)).blocks * 512);
      let duplicate = false;
      this.transaction(() => {
        if (!this.db.prepare("SELECT 1 FROM fills WHERE key=? AND token=? AND expires>?").get(key, token, Date.now())) throw new Error("cache_fill_lease_lost");
        duplicate = !!this.db.prepare("SELECT 1 FROM blobs WHERE digest=?").get(digest);
        if (!duplicate) this.db.prepare("INSERT INTO blobs VALUES(?,?,?,?,?,?,?)").run(digest, record.file, size, stored, encoding, Date.now(), record.allocated);
        this.db.prepare("INSERT INTO aliases VALUES(?,?) ON CONFLICT(key) DO UPDATE SET digest=excluded.digest").run(key, digest);
        this.trim("aliases", 200000, "rowid");
        // Bridge publication to open(), including asynchronous duplicate cleanup.
        this.db.prepare("INSERT INTO readers VALUES(?,?,?)").run(token, digest, Date.now() + 120000);
      }, true);
      if (duplicate) { await fs.unlink(file); this.metric("deduplicated", stored); }
      file = undefined;
      this.metric("fill", size); this.metric("stored", duplicate ? 0 : stored);
      const result = await this.open(digest); if (!result) throw new Error("published_blob_missing"); return result;
    } finally {
      clearTimeout(timeout); clearInterval(heartbeat); input?.destroy();
      await Promise.all([raw, gz, ...(file ? [file] : [])].map(p => fs.unlink(p).catch(error => {
        if (error.code !== "ENOENT") throw error;
      })));
      this.releaseFill(key, token);
    }
  }
  private releaseFill(key: string, token: string) {
    try {
      this.transaction(() => {
        this.releaseDisk(token);
        this.db.prepare("DELETE FROM readers WHERE token=?").run(token);
        this.db.prepare("DELETE FROM publications WHERE token=?").run(token);
        this.db.prepare("DELETE FROM fills WHERE key=? AND token=?").run(key, token);
      });
    } catch (error) { if (!isCacheContention(error)) throw error; /* Leases expire conservatively. */ }
  }
  decision(key: string) {
    try {
      const row = this.db.prepare("SELECT * FROM decisions WHERE key=? AND expires>?").get(key, Date.now());
      if (row) this.db.prepare("UPDATE decisions SET accessed=? WHERE key=? AND accessed<?").run(Date.now(), key, Date.now() - 30000);
      return row ? { digest: String(row.digest), changed: !!row.changed, isText: row.isText == null ? undefined : !!row.isText } : undefined;
    } catch (error) { return cacheError(error); }
  }
  saveDecision(key: string, digest: string, changed: boolean, isText?: boolean) {
    try {
      this.transaction(() => {
        this.db.prepare("INSERT INTO decisions(key,digest,changed,accessed,expires,isText) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET digest=excluded.digest,changed=excluded.changed,accessed=excluded.accessed,expires=excluded.expires,isText=excluded.isText")
          .run(key, digest, +changed, Date.now(), Date.now() + 7 * 86400000, isText == null ? null : +isText);
        this.trim("decisions", 100000, "accessed");
      });
    } catch (error) { if (!isCacheContention(error)) throw error; /* Optional decision can be recomputed. */ }
  }
  close() { this.disk?.close(); this.db.close(); }
}
let source: BlobCache | undefined, results: BlobCache | undefined;
export function sharedBlobCache() {
  if (!config.SHARED_CACHE_ENABLED || config.STORAGE !== "filesystem") return;
  try { return source ||= new BlobCache({ reservationRoot: config.SHARED_CACHE_PATH, root: join(config.SHARED_CACHE_PATH, "source"), budget: config.SHARED_CACHE_BYTES,
    maxObject: config.SHARED_CACHE_MAX_FILE_BYTES, gzip: config.SHARED_CACHE_GZIP, saving: config.SHARED_CACHE_GZIP_MIN_SAVING,
    freeBytes: config.SHARED_CACHE_FREE_BYTES, lowWater: config.SHARED_CACHE_LOW_WATER });
  } catch (error) { if (!isCacheContention(error)) throw error; }
}
export function resultBlobCache() {
  if (!sharedBlobCache() || !config.SHARED_CACHE_DECISIONS) return;
  try { return results ||= new BlobCache({ reservationRoot: config.SHARED_CACHE_PATH, root: join(config.SHARED_CACHE_PATH, "results"), budget: config.SHARED_CACHE_RESULT_BYTES,
    maxObject: Math.min(config.SHARED_CACHE_MAX_FILE_BYTES, Math.floor(config.SHARED_CACHE_RESULT_BYTES / 8)), gzip: config.SHARED_CACHE_GZIP,
    freeBytes: config.SHARED_CACHE_FREE_BYTES, name: "result" });
  } catch (error) { if (!isCacheContention(error)) throw error; }
}
export function closeBlobCaches() { source?.close(); results?.close(); source = results = undefined; }
