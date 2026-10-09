import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import { performance } from "perf_hooks";
import { RequestHandler } from "express";
import { createLogger } from "./logger";

export const LATENCY_BUCKETS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];
export type Service = "api" | "streamer";
export type Stage = "repository" | "authorization" | "upstream" | "cache_lookup" | "cache_fill" | "worker_wait" | "anonymize" | "streamer_headers";
export interface Metric {
  metric: string; route: string; method: string; count: number; sumMs: number;
  bytes: number; aborted: number; errors: number; slow: number; buckets: number[];
}
const logger = createLogger("requests");
const context = new AsyncLocalStorage<{ id: string; service: Service; stages: Partial<Record<Stage, number>> }>();
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const staticRoutes = new Set([
  "/", "/dashboard", "/anonymize", "/healthcheck", "/api/healthcheck", "/api/stat", "/api/stat/history",
  "/api/options", "/api/message", "/api/user", "/api/user/quota", "/api/user/dashboard", "/api/repo",
  "/api/anonymize-preview", "/api/admin/overview", "/api/admin/performance", "/api/admin/errors",
  "/api/admin/errors/stats", "/api/admin/queues", "/api/admin/queues/metrics", "/github/app/webhook",
]);

/** Fixed labels: never use repository IDs, file names or query strings as metric keys. */
export function requestRoute(url: string, service: Service): string {
  const path = url.split("?", 1)[0].replace(/\/+$/, "") || "/";
  if (service === "streamer") return ["/api/download", "/api", "/healthcheck"].includes(path) ? path : "other";
  if (staticRoutes.has(path)) return path;
  if (/^\/api\/repo\//.test(path)) {
    const match = path.match(/^\/api\/repo\/[^/]+\/(file|files|zip|options|refresh|coauthors|extend)(?:\/|$)/);
    if (match) {
      const subroute = match[1] === "files" && /\/(counts|search)$/.exec(path);
      return `/api/repo/:repoId/${match[1]}${match[1] === "file" ? "/:path" : subroute ? `/${subroute[1]}` : ""}`;
    }
    const github = path.match(/^\/api\/repo\/[^/]+\/[^/]+\/(readme|branches)$/);
    if (github) return `/api/repo/:owner/:repo/${github[1]}`;
    return "/api/repo/:repoId";
  }
  if (path.startsWith("/w/")) return "/w/:repoId/:path";
  if (/^\/(r|repository)\//.test(path)) return "/r/:repoId/:path";
  if (/^\/api\/(pr|gist)\//.test(path)) return `/api/${path.split("/")[2]}/:id/:path`;
  if (/^\/(script|css|favicon|fonts|partials)\//.test(path)) return "/assets/:path";
  if (path.startsWith("/github/")) return "/github/:action";
  if (path.startsWith("/api/admin/")) return "/api/admin/:action";
  if (path.startsWith("/api/user/")) return "/api/user/:action";
  return "other";
}

export class RequestMetrics {
  private pending = new Map<string, { minute: number; data: Metric }>();
  dropped = 0;
  constructor(private capacity = 512, private now = () => Date.now()) {}
  get size() { return this.pending.size; }
  observe(metric: string, route: string, method: string, ms: number,
    detail: { bytes?: number; aborted?: boolean; error?: boolean; slow?: boolean } = {}) {
    const minute = Math.floor(this.now() / 60000) * 60000;
    const key = JSON.stringify([minute, metric, route, method]);
    let entry = this.pending.get(key);
    if (!entry) {
      if (this.pending.size >= this.capacity) { this.dropped++; return; }
      entry = { minute, data: { metric, route, method, count: 0, sumMs: 0, bytes: 0,
        aborted: 0, errors: 0, slow: 0, buckets: Array(LATENCY_BUCKETS.length + 1).fill(0) } };
      this.pending.set(key, entry);
    }
    const duration = Math.max(0, Number.isFinite(ms) ? ms : 0);
    const data = entry.data;
    data.count++; data.sumMs += Math.round(duration); data.bytes += detail.bytes || 0;
    data.aborted += Number(!!detail.aborted); data.errors += Number(!!detail.error); data.slow += Number(!!detail.slow);
    let bucket = LATENCY_BUCKETS.findIndex(bound => duration <= bound);
    if (bucket < 0) bucket = LATENCY_BUCKETS.length;
    data.buckets[bucket]++;
  }
  drain() { const entries = [...this.pending.values()]; this.pending.clear(); return entries; }
}
export const requestMetrics = new RequestMetrics();
let activeRequests = 0;
export function activeRequestCount() { return activeRequests; }
export function requestHeaders(): Record<string, string> {
  const id = context.getStore()?.id;
  return id ? { "x-request-id": id } : {};
}
export function recordCacheHit(cache: "source" | "transformed", hit: boolean) {
  if (context.getStore()) requestMetrics.observe(`${cache}_${hit ? "hit" : "miss"}`, "all", "all", 0);
}

/** Capture the context now: worker admission can resume from another request's callback. */
export function startStage(stage: Stage) {
  const started = performance.now();
  const trace = context.getStore();
  let ended = false;
  return (error = false) => {
    if (ended) return; ended = true;
    if (!trace) return;
    const ms = performance.now() - started;
    trace.stages[stage] = (trace.stages[stage] || 0) + ms;
    requestMetrics.observe(stage, "all", "all", ms, { error });
  };
}
export async function measureStage<T>(stage: Stage, work: () => Promise<T>): Promise<T> {
  const done = startStage(stage);
  try { const value = await work(); done(); return value; }
  catch (error) { done(true); throw error; }
}

export function monitorRequests(service: Service, metrics = requestMetrics,
  log: Pick<typeof logger, "info" | "warn"> = logger): RequestHandler {
  return (req, res, next) => {
    const forwarded = service === "streamer" ? req.get("x-request-id") : undefined;
    const id = forwarded && /^[a-f0-9-]{36}$/.test(forwarded) ? forwarded : randomUUID();
    const trace = { id, service, stages: {} };
    const route = requestRoute(req.originalUrl, service);
    const method = methods.has(req.method) ? req.method : "OTHER";
    const started = performance.now();
    let firstByteMs: number | undefined;
    let bytes = 0;
    let ended = false;
    activeRequests++;
    res.setHeader("X-Request-ID", id);
    const writeHead = res.writeHead;
    res.writeHead = function (this: typeof res, ...args: unknown[]): typeof res {
      firstByteMs ??= performance.now() - started;
      return Reflect.apply(writeHead, this, args);
    };
    const count = (chunk: unknown, encoding: unknown) => {
      if (req.method === "HEAD") return;
      if (typeof chunk === "string") bytes += Buffer.byteLength(chunk, typeof encoding === "string" ? encoding as BufferEncoding : undefined);
      else if (chunk instanceof Uint8Array) bytes += chunk.byteLength;
    };
    // Preserve callbacks, return values and receiver. Installed before compression,
    // these count encoded body bytes without changing stream backpressure.
    const write = res.write;
    res.write = function (this: typeof res, ...args: unknown[]): boolean {
      count(args[0], args[1]);
      return Reflect.apply(write, this, args);
    };
    const end = res.end;
    res.end = function (this: typeof res, ...args: unknown[]): typeof res {
      count(args[0], args[1]);
      return Reflect.apply(end, this, args);
    };
    const done = () => {
      if (ended) return; ended = true;
      activeRequests--;
      res.removeListener("finish", done); res.removeListener("close", done);
      const ms = performance.now() - started;
      const aborted = !res.writableFinished;
      const transfer = /\/(file|zip)(?:\/|$)/.test(route) || route.startsWith("/w/") || service === "streamer";
      const slow = ms > (transfer ? 10000 : 1000);
      metrics.observe("request", route, method, ms, { bytes, aborted, error: res.statusCode >= 500, slow });
      if (firstByteMs != null) metrics.observe("first_byte", route, method, firstByteMs);
      const responseMs = firstByteMs == null ? null : Math.max(0, ms - firstByteMs);
      const detail = { requestId: id, service, method, route, status: res.statusCode,
        outcome: aborted ? "interrupted" : "completed", ms: Math.round(ms), firstByteMs: firstByteMs == null ? null : Math.round(firstByteMs),
        responseMs: responseMs == null ? null : Math.round(responseMs),
        bytesPerSecond: responseMs != null && responseMs >= 1 && bytes > 0 ? Math.round(bytes * 1000 / responseMs) : null,
        bytes, stages: trace.stages };
      if (slow || aborted) log.warn(aborted ? "request interrupted" : "slow request", detail);
      else if (!route.includes("healthcheck")) log.info("request", detail);
    };
    res.once("finish", done); res.once("close", done);
    context.run(trace, next);
  };
}
