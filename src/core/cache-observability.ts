import { hostname } from "os";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";
import config from "../config";
import { cacheTraffic } from "./request-monitoring";

export const CACHE_BUCKETS = [0.1, 1, 10, 100, 1000, 10000];
type Sample = { count: number; bytes: number; ms: number; buckets: number[] };
let db: DatabaseSync | undefined;
const pending = new Map<string, Sample>();
let dropped = 0;
let timer: NodeJS.Timeout | undefined;
let lastFlush = 0;
function connection() {
  if (!db) {
    mkdirSync(config.SHARED_CACHE_PATH, { recursive: true, mode: 0o700 });
    db = new DatabaseSync(join(config.SHARED_CACHE_PATH, "telemetry.sqlite"));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=50;
      CREATE TABLE IF NOT EXISTS metrics (period INTEGER, bucket INTEGER, name TEXT, traffic TEXT,
        count INTEGER, bytes INTEGER, ms REAL, b0 INTEGER, b1 INTEGER, b2 INTEGER, b3 INTEGER, b4 INTEGER, b5 INTEGER, b6 INTEGER,
        PRIMARY KEY(period,bucket,name,traffic));
      CREATE TABLE IF NOT EXISTS health (id TEXT PRIMARY KEY, updated INTEGER, dropped INTEGER);
      CREATE INDEX IF NOT EXISTS metric_time ON metrics(period,bucket);`);
  }
  return db;
}
/** Fixed event names only. No paths, terms, user identifiers or blob hashes in metrics. */
export function observeCache(name: string, bytes = 0, ms = 0, traffic = cacheTraffic()) {
  if (!config.CACHE_MONITORING_ENABLED) return;
  const key = JSON.stringify([Math.floor(Date.now() / 60000) * 60000, name, traffic]);
  if (!pending.has(key) && pending.size >= 512) { dropped++; return; }
  const value = pending.get(key) || { count: 0, bytes: 0, ms: 0, buckets: Array(7).fill(0) };
  value.count++; value.bytes += Math.max(0, bytes); value.ms += Math.max(0, ms);
  const bucket = CACHE_BUCKETS.findIndex(bound => ms <= bound);
  value.buckets[bucket < 0 ? 6 : bucket]++;
  pending.set(key, value);
  if (!timer) { timer = setInterval(flushCacheMetrics, 5000); timer.unref(); }
}
export function flushCacheMetrics() {
  if (!config.CACHE_MONITORING_ENABLED) return;
  try {
    const sql = connection();
    const insert = sql.prepare(`INSERT INTO metrics VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(period,bucket,name,traffic) DO UPDATE SET count=count+excluded.count,bytes=bytes+excluded.bytes,ms=ms+excluded.ms,
      b0=b0+excluded.b0,b1=b1+excluded.b1,b2=b2+excluded.b2,b3=b3+excluded.b3,b4=b4+excluded.b4,b5=b5+excluded.b5,b6=b6+excluded.b6`);
    sql.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of pending) {
        const [at, name, traffic] = JSON.parse(key);
        for (const period of [60000, 3600000]) insert.run(period, Math.floor(at / period) * period, name, traffic,
          value.count, value.bytes, value.ms, ...value.buckets);
      }
      sql.prepare("DELETE FROM metrics WHERE (period=60000 AND bucket<?) OR (period=3600000 AND bucket<?)")
        .run(Date.now() - 48 * 3600000, Date.now() - 30 * 86400000);
      sql.prepare("INSERT OR REPLACE INTO health VALUES(?,?,?)").run(`${hostname()}:${process.pid}`, Date.now(), dropped);
      sql.prepare("DELETE FROM health WHERE updated<?").run(Date.now() - 30 * 86400000);
      sql.exec("COMMIT"); pending.clear(); lastFlush = Date.now();
    } catch (error) { sql.exec("ROLLBACK"); throw error; }
  } catch { dropped += [...pending.values()].reduce((sum, v) => sum + v.count, 0); pending.clear(); }
}
export function cacheMetricsReport(minutes = 60) {
  if (!config.CACHE_MONITORING_ENABLED) return { available: false, reason: "Monitoring is disabled", rows: [] };
  flushCacheMetrics();
  const windowMinutes = [15, 60, 1440, 10080].includes(minutes) ? minutes : 60;
  try {
    const sql = connection();
    const rows = sql.prepare(`SELECT name,traffic,SUM(count) count,SUM(bytes) bytes,SUM(ms) ms,
      SUM(b0) b0,SUM(b1) b1,SUM(b2) b2,SUM(b3) b3,SUM(b4) b4,SUM(b5) b5,SUM(b6) b6
      FROM metrics WHERE period=? AND bucket>=? GROUP BY name,traffic ORDER BY name,traffic`)
      .all(windowMinutes > 2880 ? 3600000 : 60000, Date.now() - windowMinutes * 60000);
    const health = sql.prepare("SELECT COALESCE(SUM(dropped),0) dropped FROM health").get();
    return { available: true, windowMinutes, sampledAt: Date.now(), lastFlush, dropped: health?.dropped, rows, latencyBucketsMs: CACHE_BUCKETS };
  } catch { return { available: false, reason: "Cache telemetry could not be read", rows: [], dropped }; }
}
export function closeCacheMetrics() { clearInterval(timer); timer = undefined; flushCacheMetrics(); db?.close(); db = undefined; }
