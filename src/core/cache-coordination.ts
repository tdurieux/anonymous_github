import { createClient } from "redis";
import { randomUUID } from "crypto";
import config from "../config";

let connection: ReturnType<typeof createClient> | undefined;
let connecting: Promise<ReturnType<typeof createClient> | undefined> | undefined;
let retryAt = 0;
/** Bound commands even when a connected server stops replying. */
export async function cacheCommand<T>(command: Promise<T>, client: ReturnType<typeof createClient>, timeoutMs = 1000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([command, new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        retryAt = Date.now() + 30_000;
        if (connection === client) connection = undefined;
        if (client.isOpen) client.destroy();
        reject(new Error("cache_command_timeout"));
      }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
export async function cacheRedis() {
  if (connection?.isReady) return connection;
  if (connecting) return connecting;
  if (Date.now() < retryAt) return undefined;
  connecting = (async () => {
    const client = createClient({ disableOfflineQueue: true, socket: {
      host: config.REDIS_HOSTNAME, port: config.REDIS_PORT,
      connectTimeout: 500, reconnectStrategy: false,
    } });
    client.on("error", () => {});
    try { await cacheCommand(client.connect(), client, 500); connection = client; return client; }
    catch { retryAt = Date.now() + 30_000; if (client.isOpen) client.destroy(); return undefined; }
    finally { connecting = undefined; }
  })();
  return connecting;
}

/** A renewable lease. Followers recheck durable output; they never share a Readable. */
export async function coordinatedFill<T>(
  key: string, read: () => Promise<T | undefined>, produce: () => Promise<T>,
  waitMs = 120_000
): Promise<T> {
  const redis = await cacheRedis();
  if (!redis) return produce();
  const lockKey = `perf:lease:${key}`;
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    let owned: string | null;
    try { owned = await cacheCommand(redis.set(lockKey, token, { NX: true, PX: 30_000 }), redis); }
    catch { return produce(); }
    if (owned) {
      const heartbeat = setInterval(() => {
        void cacheCommand(redis.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end", {
          keys: [lockKey], arguments: [token, "30000"],
        }), redis).catch(() => {});
      }, 10_000);
      heartbeat.unref();
      try {
        // Coordination is optional. A lost heartbeat cannot invalidate output
        // that the producer has already completed and verified.
        return await produce();
      } finally {
        clearInterval(heartbeat);
        await cacheCommand(redis.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", {
          keys: [lockKey], arguments: [token],
        }), redis).catch(() => {});
      }
    }
    if (Date.now() >= deadline) throw new Error("cache_fill_timeout");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export async function closeCacheRedis() {
  const current = connection;
  connection = undefined;
  retryAt = 0;
  if (current?.isOpen) current.destroy();
}
