import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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
export function maintainTextSpools() {
  if (cleanup) return cleanup;
  if (Date.now() < nextCleanup) return Promise.resolve();
  nextCleanup = Date.now() + 60_000;
  cleanup = removeStaleTextSpools().catch(() => {}).finally(() => { cleanup = undefined; });
  return cleanup;
}
