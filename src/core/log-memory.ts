import { readFile } from "fs/promises";
export function memoryBreakdown(used: number, max: number, stat: string) {
  const fields = new Map(stat.trim().split("\n").map(line => line.trim().split(/\s+/) as [string, string]));
  const file = Number(fields.get("file") ?? fields.get("total_cache"));
  const inactive = Number(fields.get("inactive_file") ?? fields.get("total_inactive_file"));
  if (!Number.isFinite(file) || !Number.isFinite(inactive) || file < 0 || inactive < 0) return {};
  const working = Math.max(0, used - Math.min(used, inactive));
  return { memoryFileCacheBytes: file, memoryWorkingSetBytes: working, memoryWorkingSetRatio: working / max };
}
/** Container usage includes sandbox workers and page cache; process RSS does not. */
export async function logMemory() {
  const rss = process.memoryUsage().rss;
  for (const [usage, limit] of [
    ["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.max"],
    ["/sys/fs/cgroup/memory/memory.usage_in_bytes", "/sys/fs/cgroup/memory/memory.limit_in_bytes"],
  ]) {
    const [used, max] = await Promise.all([usage, limit].map(path => readFile(path, "utf8").then(Number).catch(() => NaN)));
    if (Number.isFinite(used) && max > 0 && max < Number.MAX_SAFE_INTEGER) {
      const stat = await readFile(usage.replace(/memory\.(current|usage_in_bytes)$/, "memory.stat"), "utf8").catch(() => "");
      return { rss, memoryUsedBytes: used, memoryLimitBytes: max, memoryRatio: used / max, ...memoryBreakdown(used, max, stat) };
    }
  }
  return { rss };
}
