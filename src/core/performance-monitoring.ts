import { createClient, RedisClientType } from "redis";
import { hostname } from "os";
import { readdir, readFile, readlink } from "fs/promises";
import { monitorEventLoopDelay, performance } from "perf_hooks";
import config from "../config";
import { AsyncCache } from "./async-cache";
import { activeRequestCount, LATENCY_BUCKETS, Metric, requestMetrics, Service } from "./request-monitoring";

const PREFIX = "performance:v1:";
const RETENTION = 2 * 3600;
let client: RedisClientType | undefined;
let stop: (() => Promise<void>) | undefined;
let flushNow: (() => Promise<void>) | undefined;
const reports = new AsyncCache<unknown>(10000, 2);
const emptyMetric = (metric: string, route: string, method: string): Metric => ({ metric, route, method,
  count: 0, sumMs: 0, bytes: 0, aborted: 0, errors: 0, slow: 0, buckets: Array(LATENCY_BUCKETS.length + 1).fill(0) });

async function containerMemoryLimit() {
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    const raw = await readFile(path, "utf8").catch(() => "");
    const value = Number(raw.trim());
    if (value > 0 && value < Number.MAX_SAFE_INTEGER) return value;
  }
  return null;
}

async function redisDeadline<T>(work: Promise<T>, redis: RedisClientType): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("performance_monitoring_timeout"));
        if (redis.isOpen) {
          redis.destroy();
          if (client === redis) void redis.connect().catch(() => {});
        }
      }, 2000); timer.unref();
    })]);
  } finally { clearTimeout(timer); }
}

export async function flushPerformanceMetrics() { await flushNow?.(); reports.clear(); }

export function percentileUpperBound(buckets: number[], percentile: number): number | null {
  const total = buckets.reduce((sum, count) => sum + count, 0);
  if (!total) return null;
  let count = 0;
  for (let i = 0; i < buckets.length; i++) {
    count += buckets[i];
    if (count >= Math.ceil(total * percentile)) return LATENCY_BUCKETS[i] ?? null;
  }
  return null;
}

/** PID-owned sockets only: /proc/net also includes healthcheck subprocesses. */
export async function socketSnapshot() {
  try {
    const descriptors = (await readdir("/proc/self/fd")).slice(0, 4096);
    const sockets = new Set<string>();
    for (let i = 0; i < descriptors.length; i += 32) {
      const links = await Promise.all(descriptors.slice(i, i + 32).map(fd => readlink(`/proc/self/fd/${fd}`).catch(() => "")));
      for (const link of links) { const match = /^socket:\[(\d+)\]$/.exec(link); if (match) sockets.add(match[1]); }
    }
    const states: Record<string, number> = {};
    for (const file of ["/proc/self/net/tcp", "/proc/self/net/tcp6"]) {
      const table = await readFile(file, "utf8");
      for (const line of table.trim().split("\n").slice(1)) {
        const columns = line.trim().split(/\s+/);
        if (sockets.has(columns[9])) states[columns[3]] = (states[columns[3]] || 0) + 1;
      }
    }
    return { descriptors: sockets.size, established: states["01"] || 0, closeWait: states["08"] || 0,
      listening: states["0A"] || 0, truncated: descriptors.length === 4096 };
  } catch { return null; }
}

/** One bounded batch every 15s. Redis outages never queue commands or hold HTTP requests. */
export function startPerformanceMonitoring(service: Service, workers: () => unknown = () => null) {
  if (stop) return stop;
  const redis = createClient({ disableOfflineQueue: true, socket: { host: config.REDIS_HOSTNAME,
    port: config.REDIS_PORT, connectTimeout: 2000, reconnectStrategy: (retries: number) => Math.min(5000, 250 * (retries + 1)) } }) as RedisClientType;
  client = redis;
  redis.on("error", () => {});
  void redis.connect().catch(() => {});
  const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
  let previousUtilization = performance.eventLoopUtilization();
  let previousCpu = process.cpuUsage();
  let previousCpuAt = performance.now();
  let busy = false;
  let droppedBatches = 0;
  let lastFlushAt: number | null = null;
  let stopped = false;
  const instance = `${service}:${hostname()}`;
  const flush = async () => {
    if (busy || stopped) return;
    busy = true;
    const entries = requestMetrics.drain();
    try {
      if (!redis.isReady) { droppedBatches += entries.length ? 1 : 0; return; }
      const utilization = performance.eventLoopUtilization(previousUtilization);
      previousUtilization = performance.eventLoopUtilization();
      const cpu = process.cpuUsage(previousCpu);
      const cpuAt = performance.now();
      const cpuPercent = (cpu.user + cpu.system) / ((cpuAt - previousCpuAt) * 1000) * 100;
      previousCpu = process.cpuUsage(); previousCpuAt = cpuAt;
      const runtime = { instance, service, sampledAt: Date.now(), uptime: process.uptime(),
        cpuPercent, memoryLimitBytes: await containerMemoryLimit(),
        memory: process.memoryUsage(), activeRequests: activeRequestCount(), sockets: await socketSnapshot(), workers: workers(),
        eventLoop: { utilization: utilization.utilization, p95Ms: loop.percentile(95) / 1e6,
          maxMs: Number.isFinite(loop.max) ? loop.max / 1e6 : 0 },
        droppedMetrics: requestMetrics.dropped, droppedBatches, lastFlushAt };
      loop.reset();
      const tx = redis.multi();
      const touched = new Set<string>();
      for (const { minute, data } of entries) {
        const key = `${PREFIX}minute:${service}:${minute}`;
        touched.add(key);
        const label = JSON.stringify([data.metric, data.route, data.method]);
        const fields: Record<string, number> = { count: data.count, sumMs: data.sumMs, bytes: data.bytes,
          aborted: data.aborted, errors: data.errors, slow: data.slow };
        data.buckets.forEach((count, i) => { fields[`b${i}`] = count; });
        for (const [field, value] of Object.entries(fields)) if (value) tx.hIncrBy(key, `${label}|${field}`, value);
      }
      for (const key of touched) tx.expire(key, RETENTION);
      tx.set(`${PREFIX}instance:${instance}`, JSON.stringify(runtime), { EX: 90 });
      tx.zAdd(`${PREFIX}instances`, { score: runtime.sampledAt, value: instance });
      tx.zRemRangeByScore(`${PREFIX}instances`, 0, runtime.sampledAt - 90000);
      tx.expire(`${PREFIX}instances`, 120);
      tx.lPush(`${PREFIX}runtime:${service}`, JSON.stringify(runtime));
      tx.lTrim(`${PREFIX}runtime:${service}`, 0, service === "api" ? 239 : 959);
      tx.expire(`${PREFIX}runtime:${service}`, RETENTION);
      await redisDeadline(tx.exec(), redis); lastFlushAt = Date.now();
    } catch { droppedBatches++; }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void flush(); }, 15000); timer.unref();
  flushNow = flush;
  void flush();
  stop = async () => {
    stopped = true; clearInterval(timer); loop.disable();
    if (redis.isOpen) redis.destroy();
    client = undefined; stop = undefined; flushNow = undefined; reports.clear();
  };
  return stop;
}

export async function performanceReport(minutes: number) {
  const windowMinutes = minutes === 60 ? 60 : 15;
  if (!client?.isReady) return { available: false, windowMinutes, instances: [], routes: [], stages: [] };
  const redis = client;
  return reports.get(String(windowMinutes), async () => {
    const minute = Math.floor(Date.now() / 60000) * 60000;
    const groups = new Map<string, Metric & { service: Service }>();
    const tx = redis.multi();
    const requests: { service: Service; minute: number }[] = [];
    for (const service of ["api", "streamer"] as const) {
      for (let i = 0; i < windowMinutes; i++) {
        requests.push({ service, minute: minute - i * 60000 });
        tx.hGetAll(`${PREFIX}minute:${service}:${minute - i * 60000}`);
      }
    }
    const values = await redisDeadline(tx.exec(), redis) as unknown as Record<string, string>[];
    const series = new Map<number, { minute: number; requests: number; aborted: number; errors: number; sumMs: number }>();
    values.forEach((hash, index) => {
      for (const [key, raw] of Object.entries(hash || {})) {
        const split = key.lastIndexOf("|");
        const label = key.slice(0, split); const field = key.slice(split + 1);
        const [metric, route, method] = JSON.parse(label) as string[];
        const service = requests[index].service;
        const id = `${service}:${label}`;
        let row = groups.get(id);
        if (!row) { row = { ...emptyMetric(metric, route, method), service }; groups.set(id, row); }
        const value = Number(raw) || 0;
        if (/^b\d+$/.test(field)) row.buckets[Number(field.slice(1))] += value;
        else if (["count", "sumMs", "bytes", "aborted", "errors", "slow"].includes(field)) {
          const numericField = field as "count" | "sumMs" | "bytes" | "aborted" | "errors" | "slow";
          row[numericField] += value;
        }
        if (metric === "request" && service === "api") {
          const timestamp = requests[index].minute;
          const point = series.get(timestamp) || { minute: timestamp, requests: 0, aborted: 0, errors: 0, sumMs: 0 };
          if (field === "count") point.requests += value;
          if (field === "sumMs") point.sumMs += value;
          if (field === "aborted") point.aborted += value;
          if (field === "errors") point.errors += value;
          series.set(timestamp, point);
        }
      }
    });
    const ids = await redisDeadline(redis.zRangeByScore(`${PREFIX}instances`, Date.now() - 90000, "+inf", { LIMIT: { offset: 0, count: 32 } }), redis);
    const samples = ids.length ? await redisDeadline(redis.mGet(ids.map(id => `${PREFIX}instance:${id}`)), redis) : [];
    const instances = samples.filter((sample): sample is string => !!sample).map(sample => JSON.parse(sample));
    const runtimeSeries: { instance: string; service: string; sampledAt: number; rss: number; heapUsed: number; external: number;
      cpuPercent: number; loopP95Ms: number; sockets: number | null; closeWait: number | null; waiting: number; reservedBytes: number }[] = [];
    for (const service of ["api", "streamer"]) {
      const samples = await redisDeadline(redis.lRange(`${PREFIX}runtime:${service}`, 0, service === "api" ? 239 : 959), redis);
      for (const raw of samples) {
        const sample = JSON.parse(raw);
        if (sample.sampledAt >= Date.now() - windowMinutes * 60000) runtimeSeries.push({ service, instance: sample.instance,
          sampledAt: sample.sampledAt, rss: sample.memory.rss, heapUsed: sample.memory.heapUsed, external: sample.memory.external,
          cpuPercent: sample.cpuPercent, loopP95Ms: sample.eventLoop.p95Ms, sockets: sample.sockets?.descriptors ?? null,
          closeWait: sample.sockets?.closeWait ?? null, waiting: sample.workers?.waiting || 0, reservedBytes: sample.workers?.reservedBytes || 0 });
      }
    }
    const rows = [...groups.values()].map(row => ({ ...row, avgMs: row.count ? Math.round(row.sumMs / row.count) : 0,
      p95UpperMs: percentileUpperBound(row.buckets, .95), p99UpperMs: percentileUpperBound(row.buckets, .99) }));
    return { available: true, generatedAt: Date.now(), windowMinutes, instances,
      routes: rows.filter(row => row.metric === "request").map(row => {
        const firstByte = rows.find(sample => sample.metric === "first_byte" && sample.service === row.service && sample.route === row.route && sample.method === row.method);
        return { ...row, firstByteCount: firstByte?.count || 0, firstByteP95UpperMs: firstByte?.p95UpperMs ?? null };
      }).sort((a, b) => b.sumMs - a.sumMs),
      stages: rows.filter(row => row.metric !== "request"), series: [...series.values()].sort((a, b) => a.minute - b.minute),
      runtimeSeries, latencyBucketsMs: LATENCY_BUCKETS,
      percentileNote: "Percentiles are histogram bucket upper bounds; null means no samples or above 60s." };
  });
}
