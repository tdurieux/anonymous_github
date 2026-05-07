import { createClient, RedisClientType } from "redis";
import config from "../config";

const KEY_PREFIX = "qmetrics";
const TTL_SECONDS = 7 * 24 * 3600 + 3600;

let client: RedisClientType | null = null;
let disabled = false;

function getClient(): RedisClientType | null {
  if (disabled) return null;
  if (client) return client;
  try {
    client = createClient({
      socket: {
        host: config.REDIS_HOSTNAME,
        port: config.REDIS_PORT,
        reconnectStrategy: () => false as any,
      },
    }) as RedisClientType;
    client.on("error", () => {
      disabled = true;
      client?.disconnect().catch(() => {});
      client = null;
    });
    client.connect().catch(() => {
      disabled = true;
      client = null;
    });
    return client;
  } catch {
    disabled = true;
    return null;
  }
}

function minuteTs(now?: number): number {
  return Math.floor((now || Date.now()) / 60000) * 60000;
}

function key(queue: string, ts: number): string {
  return `${KEY_PREFIX}:${queue}:${ts}`;
}

export async function recordMetric(
  queue: string,
  type: "completed" | "failed",
  durationMs: number
): Promise<void> {
  const c = getClient();
  if (!c || !c.isOpen) return;
  const k = key(queue, minuteTs());
  const field = type === "completed" ? "c" : "f";
  try {
    const pipe = c.multi();
    pipe.hIncrBy(k, field, 1);
    pipe.hIncrBy(k, "ms", Math.round(Math.max(0, durationMs)));
    pipe.expire(k, TTL_SECONDS);
    await pipe.exec();
  } catch {
    // non-critical, don't crash workers
  }
}

export interface MetricPoint {
  ts: number;
  completed: number;
  failed: number;
  avgMs: number;
}

const METRIC_FIELDS = ["c", "f", "ms"];
const metricsCache = new Map<string, { data: MetricPoint[]; ts: number }>();
const METRICS_CACHE_TTL = 30_000;

export async function queryMetrics(
  queue: string,
  rangeMinutes: number
): Promise<MetricPoint[]> {
  const cacheKey = `${queue}:${rangeMinutes}`;
  const cached = metricsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < METRICS_CACHE_TTL) return cached.data;

  const c = getClient();
  if (!c || !c.isOpen) return [];

  const now = minuteTs();
  const start = now - (rangeMinutes - 1) * 60000;

  const keys: string[] = [];
  const timestamps: number[] = [];
  for (let t = start; t <= now; t += 60000) {
    keys.push(key(queue, t));
    timestamps.push(t);
  }

  try {
    const pipe = c.multi();
    for (const k of keys) pipe.hmGet(k, METRIC_FIELDS);
    const results = await pipe.exec();

    const points = timestamps.map((ts, i) => {
      const vals = (results[i] as unknown as (string | null)[]) || [];
      const completed = parseInt(vals[0] || "0", 10) || 0;
      const failed = parseInt(vals[1] || "0", 10) || 0;
      const totalMs = parseInt(vals[2] || "0", 10) || 0;
      const total = completed + failed;
      return {
        ts,
        completed,
        failed,
        avgMs: total > 0 ? Math.round(totalMs / total) : 0,
      };
    });
    metricsCache.set(cacheKey, { data: points, ts: Date.now() });
    return points;
  } catch {
    return [];
  }
}
