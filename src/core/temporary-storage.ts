import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { pruneTransformedCache } from "./transformed-cache";
import { createLogger } from "./logger";

const logger = createLogger("temporary-storage");

let nextCleanup = 0;
let cleanup: Promise<void> | undefined;
/** Jobs time out in minutes; an hour-old spool belongs to an interrupted process. */
export async function removeStaleTextSpools(directory = tmpdir(), now = Date.now()) {
  const entries = await fs.opendir(directory);
  for await (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("anonymous-text-")) continue;
    const path = join(directory, entry.name);
    try {
      if (now - (await fs.stat(path)).mtimeMs > 3600_000) await fs.rm(path, { recursive: true, force: true });
    } catch { /* another process can finish cleanup first */ }
  }
}
export function maintainTextSpools(force = false) {
  if (cleanup) return cleanup;
  if (!force && Date.now() < nextCleanup) return Promise.resolve();
  nextCleanup = Date.now() + 60_000;
  cleanup = removeStaleTextSpools().catch(() => {}).finally(() => { cleanup = undefined; });
  return cleanup;
}

/** Recover on startup and continue while idle, without overlapping scans. */
export async function startTemporaryStorageMaintenance(intervalMs = 60_000) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const results = await Promise.allSettled([maintainTextSpools(true), pruneTransformedCache()]);
      for (const result of results) if (result.status === "rejected") {
        logger.warn("temporary storage cleanup deferred", { message: (result.reason as Error).message });
      }
    } finally { running = false; }
  };
  await run();
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
