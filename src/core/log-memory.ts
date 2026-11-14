import { readFile } from "fs/promises";
/** Container usage includes sandbox workers and page cache; process RSS does not. */
export async function logMemory() {
  const rss = process.memoryUsage().rss;
  for (const [usage, limit] of [
    ["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.max"],
    ["/sys/fs/cgroup/memory/memory.usage_in_bytes", "/sys/fs/cgroup/memory/memory.limit_in_bytes"],
  ]) {
    const [used, max] = await Promise.all([usage, limit].map(path => readFile(path, "utf8").then(Number).catch(() => NaN)));
    if (Number.isFinite(used) && max > 0 && max < Number.MAX_SAFE_INTEGER) {
      return { rss, memoryLimitBytes: max, memoryRatio: used / max };
    }
  }
  return { rss };
}
