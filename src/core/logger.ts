import { createClient, RedisClientType } from "redis";
import config from "../config";

export const ERROR_LOG_KEY = "admin:errors";
export const ERROR_LOG_MAX = 1000;

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

function persistError(entry: {
  ts: string;
  module: string;
  message: string;
  raw: unknown[];
}) {
  const client = getRedis();
  if (!client || !client.isOpen) return;
  const payload = JSON.stringify(entry);
  client
    .multi()
    .lPush(ERROR_LOG_KEY, payload)
    .lTrim(ERROR_LOG_KEY, 0, ERROR_LOG_MAX - 1)
    .exec()
    .catch(() => undefined);
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
  if (level === "error") {
    persistError({
      ts,
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
