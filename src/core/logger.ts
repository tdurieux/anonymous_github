import { createClient, RedisClientType } from "redis";
import config from "../config";

export const ERROR_LOG_KEY = "admin:errors";
export const ERROR_LOG_MAX = 5000;
export const ERROR_LOG_HOURLY_PREFIX = "admin:errors:hourly:";
export const ERROR_LOG_DROPPED_KEY = "admin:errors:dropped";
// 48h retention on the hourly counters: stats endpoint reads "last 24h" and
// "previous 24h" buckets — anything older has nothing to compare against.
export const ERROR_LOG_HOURLY_TTL = 48 * 60 * 60;
// Hard cap on the JSON payload stored per entry. The recent detail() change
// (commit 6f418d6) can produce kilobyte payloads; without a cap the read
// path pulls multiple MB on every poll.
const MAX_PAYLOAD_BYTES = 4096;

export type Logger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveThreshold(): number {
  const raw = (process.env.LOG_LEVEL || "").toLowerCase() as Level;
  if (raw in LEVEL_ORDER) return LEVEL_ORDER[raw];
  return process.env.NODE_ENV === "production"
    ? LEVEL_ORDER.info
    : LEVEL_ORDER.debug;
}

const threshold = resolveThreshold();

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return JSON.stringify(serializeError(a));
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

let redisClient: RedisClientType | null = null;
let redisDisabled = false;

function getRedis(): RedisClientType | null {
  if (redisDisabled) return null;
  if (redisClient) return redisClient;
  try {
    redisClient = createClient({
      socket: {
        host: config.REDIS_HOSTNAME,
        port: config.REDIS_PORT,
        // Give up on first failure — we don't want the redis client's
        // reconnect timer keeping the event loop alive (breaks unit tests
        // that just import the logger), and we don't want logger.error to
        // recursively retrigger if redis is down.
        reconnectStrategy: false,
      },
    }) as RedisClientType;
    redisClient.on("error", () => {
      if (redisDisabled) return;
      redisDisabled = true;
      const c = redisClient;
      redisClient = null;
      if (c?.isOpen) {
        c.disconnect().catch(() => {});
      }
    });
    redisClient.connect().catch(() => {
      redisDisabled = true;
    });
    return redisClient;
  } catch {
    redisDisabled = true;
    return null;
  }
}

// In-process counter for entries that couldn't be persisted (no Redis client,
// disconnected, or Redis-side rejection). Mirrors `admin:errors:dropped` once
// Redis is back. Read by /admin/errors/stats so the admin page surfaces
// "you're losing logs" instead of silently rendering an empty table.
let droppedInProcess = 0;
export function getInProcessDropped(): number {
  return droppedInProcess;
}

function trimStack(s: unknown): unknown {
  if (typeof s === "string" && s.length > 800) {
    return s.slice(0, 800) + "…[truncated]";
  }
  return s;
}
function trimRawArg(a: unknown): unknown {
  if (!a || typeof a !== "object") return a;
  const o = a as Record<string, unknown>;
  if (typeof o.stack === "string") {
    return { ...o, stack: trimStack(o.stack) };
  }
  return o;
}

function clampPayload(entry: {
  ts: string;
  level: "warn" | "error";
  module: string;
  message: string;
  raw: unknown[];
}): string {
  // Cap raw to first 3 args and trim long stacks before stringifying.
  if (entry.raw.length > 3) entry.raw = entry.raw.slice(0, 3);
  entry.raw = entry.raw.map(trimRawArg);
  let s = JSON.stringify(entry);
  if (s.length <= MAX_PAYLOAD_BYTES) return s;
  // Step 1: keep just the first arg (typically the human message + the
  // structured detail object).
  entry.raw = entry.raw.slice(0, 1);
  s = JSON.stringify(entry);
  if (s.length <= MAX_PAYLOAD_BYTES) return s;
  // Step 2: replace the payload with a placeholder so the entry still shows
  // up in the list but doesn't blow the cap.
  entry.raw = [{ truncated: true, originalBytes: s.length }];
  return JSON.stringify(entry);
}

// Map a logged entry to the bucket the admin UI uses. Mirrors the inline
// logic in /errors/stats so server and client agree on what "5xx / 4xx /
// info" means.
function bucketFor(
  detail: Record<string, unknown> | undefined,
  level: "warn" | "error"
): "error" | "warn" | "info" {
  const s =
    detail && typeof detail.httpStatus === "number"
      ? (detail.httpStatus as number)
      : detail && typeof detail.status === "number"
        ? (detail.status as number)
        : null;
  if (typeof s === "number") {
    if (s >= 500) return "error";
    if (s === 401 || s === 403 || s === 404) return "info";
    if (s >= 400) return "warn";
  }
  return level === "error" ? "error" : "warn";
}

function hourKey(ts: string): string {
  // YYYYMMDDHH in UTC — sortable, lexicographically aligns with time.
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `${ERROR_LOG_HOURLY_PREFIX}${y}${m}${day}${h}`;
}

function persistError(entry: {
  ts: string;
  level: "warn" | "error";
  module: string;
  message: string;
  raw: unknown[];
}) {
  const client = getRedis();
  if (!client || !client.isOpen) {
    droppedInProcess++;
    return;
  }
  // Pre-compute the structured fields the stats endpoint needs so the read
  // path doesn't have to parse the JSON list at all.
  const detail = entry.raw.find(
    (a) => a && typeof a === "object" && !Array.isArray(a)
  ) as Record<string, unknown> | undefined;
  const bucket = bucketFor(detail, entry.level);
  const code =
    (detail && typeof detail.message === "string"
      ? (detail.message as string)
      : "") ||
    (detail && typeof detail.code === "string"
      ? (detail.code as string)
      : "") ||
    "_";
  // Routine client misuse (401/403/404 and the allowlisted "expected" 4xx
  // codes below) drowns out real errors in the recent-entries ring. Keep the
  // hourly counters so spikes still show on the admin page, but don't push
  // these entries into the bounded list.
  const noisyCodes = new Set([
    "repository_expired",
    "repository_not_ready",
    "repoId_already_used",
    "invalid_repoId",
    "page_not_supported_on_different_branch",
  ]);
  const skipRing = bucket === "info" || noisyCodes.has(code);
  const hKey = hourKey(entry.ts);
  const tx = client.multi();
  if (!skipRing) {
    tx.lPush(ERROR_LOG_KEY, clampPayload(entry)).lTrim(
      ERROR_LOG_KEY,
      0,
      ERROR_LOG_MAX - 1
    );
  }
  tx.hIncrBy(hKey, "total", 1)
    .hIncrBy(hKey, `bucket:${bucket}`, 1)
    .hIncrBy(hKey, `level:${entry.level}`, 1)
    .hIncrBy(hKey, `module:${entry.module}`, 1)
    .hIncrBy(hKey, `cb:${bucket}:${code}`, 1)
    .expire(hKey, ERROR_LOG_HOURLY_TTL)
    .exec()
    .catch(() => {
      droppedInProcess++;
      // Best-effort flush of the in-process counter to redis so the admin UI
      // sees the same number across processes.
      const c = getRedis();
      if (c && c.isOpen) {
        c.incr(ERROR_LOG_DROPPED_KEY).catch(() => undefined);
      }
    });
}

function emit(level: Level, module: string, args: unknown[]) {
  if (LEVEL_ORDER[level] < threshold) return;
  const ts = new Date().toISOString();
  const formatted = args.map(formatArg);
  const line = `${ts} ${level.toUpperCase()} [${module}] ${formatted.join(" ")}`;
  const sink =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : level === "debug"
          ? console.debug
          : console.log;
  sink(line);
  if (level === "error" || level === "warn") {
    persistError({
      ts,
      level,
      module,
      message: typeof args[0] === "string" ? args[0] : "",
      raw: args.map((a) => {
        if (a instanceof Error) return serializeError(a);
        return a;
      }),
    });
  }
}

export function createLogger(module: string): Logger {
  return {
    debug: (...args) => emit("debug", module, args),
    info: (...args) => emit("info", module, args),
    warn: (...args) => emit("warn", module, args),
    error: (...args) => emit("error", module, args),
  };
}

type ErrorLike = {
  name?: string;
  message?: string;
  stack?: string;
  status?: number;
  httpStatus?: number;
  code?: string | number;
  cause?: unknown;
  request?: { url?: string; method?: string };
  response?: { url?: string; status?: number };
  detail?: () => string | undefined;
  url?: string | (() => string | undefined);
};

export function serializeError(err: unknown): Record<string, unknown> {
  if (err == null) return { value: err };
  if (typeof err !== "object") return { value: String(err) };

  const e = err as ErrorLike;
  const out: Record<string, unknown> = {};
  if (e.name) out.name = e.name;
  if (e.message) out.message = e.message;

  // Octokit RequestError / HTTP-shaped errors: surface status + url + method,
  // skip the giant headers/response body dump.
  if (typeof e.status === "number") out.status = e.status;
  if (e.request?.url) out.url = e.request.url;
  if (e.request?.method) out.method = e.request.method;
  if (!e.request && e.response?.url) out.url = e.response.url;

  // AnonymousError carries an httpStatus and an inner cause.
  if (typeof e.httpStatus === "number") out.httpStatus = e.httpStatus;
  if (e.code !== undefined && e.code !== e.message) out.code = e.code;
  if (typeof e.url === "function") {
    try {
      const u = e.url();
      if (u) out.url = u;
    } catch {
      /* ignore */
    }
  }
  if (typeof e.detail === "function") {
    try {
      const d = e.detail();
      if (d) out.detail = d;
    } catch {
      /* ignore */
    }
  }
  if (e.cause) out.cause = serializeError(e.cause);

  // Only include the stack when there's nothing else useful — avoids dumping
  // a stack for handled HTTP errors but keeps debuggability for plain Errors.
  if (!out.status && !out.httpStatus && e.stack) out.stack = e.stack;

  return out;
}
