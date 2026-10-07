import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash, randomUUID } from "crypto";
import config from "../config";
import { coordinatedFill } from "./cache-coordination";
const root = join(tmpdir(), "anonymous-transformed-v1");
const TTL = 3600_000;
const DISK_BUDGET = 512 * 1024 * 1024;
const fills = new Map<string, Promise<boolean>>();

/** The key includes actual content, all rules, generation, and matcher version. */
export async function transformedFile(digest: string, options: unknown, output: string,
  produce: () => Promise<boolean>): Promise<boolean> {
  const key = createHash("sha256").update(JSON.stringify(["matcher-v1", digest, options,
    config.ANONYMIZATION_MASK, config.APP_HOSTNAME])).digest("hex");
  const data = join(root, `${key}.data`), metadata = join(root, `${key}.json`);
  const read = async () => {
    try {
      const record = JSON.parse(await fs.readFile(metadata, "utf8"));
      if (Date.now() - record.created > TTL || (await fs.stat(data)).size !== record.size) return undefined;
      return Boolean(record.changed);
    } catch { return undefined; }
  };
  const copyCached = async (changed: boolean) => {
    await fs.copyFile(data, output, fs.constants.COPYFILE_EXCL);
    return changed;
  };
  const hit = await read();
  if (hit !== undefined) {
    try { return await copyCached(hit); } catch { /* eviction: retry the transformation */ }
  }
  const pending = fills.get(key);
  if (pending) {
    await pending.catch(() => {});
    const cached = await read();
    if (cached !== undefined) { try { return await copyCached(cached); } catch { /* retry */ } }
  }
  if (fills.size >= 64) return produce();
  let producedHere = false;
  const task = coordinatedFill(`transformed:${key}`, read, async () => {
    const changed = await produce();
    producedHere = true;
    const size = (await fs.stat(output)).size;
    if (size > DISK_BUDGET / 4) return changed;
    const token = randomUUID();
    const tempData = `${data}.${token}.tmp`, tempMetadata = `${metadata}.${token}.tmp`;
    try {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.copyFile(output, tempData);
      await fs.writeFile(tempMetadata, JSON.stringify({ changed, size, created: Date.now() }));
      await fs.rename(tempData, data);
      await fs.rename(tempMetadata, metadata);
      await prune();
    } catch { /* A valid private output remains usable when cache storage fails. */
    } finally {
      await Promise.all([tempData, tempMetadata].map(path => fs.rm(path, { force: true }).catch(() => {})));
    }
    return changed;
  });
  fills.set(key, task);
  try {
    const changed = await task;
    if (producedHere) return changed;
    try { return await copyCached(changed); } catch { return produce(); }
  } finally { if (fills.get(key) === task) fills.delete(key); }
}
async function prune() {
  const records = [];
  for (const name of await fs.readdir(root)) {
    if (name.endsWith(".tmp") || name.endsWith(".data")) {
      const path = join(root, name);
      try { if (Date.now() - (await fs.stat(path)).mtimeMs > TTL) await fs.rm(path, { force: true }); } catch { /* another publisher */ }
    }
    if (!name.endsWith(".json")) continue;
    const path = join(root, name);
    try { const record = JSON.parse(await fs.readFile(path, "utf8")); records.push({ path, ...record }); } catch { /* another publisher */ }
  }
  records.sort((a, b) => b.created - a.created);
  let bytes = 0;
  for (let i = 0; i < records.length; i++) {
    const record = records[i]; bytes += record.size;
    if (i >= 128 || bytes > DISK_BUDGET || Date.now() - record.created > TTL) {
      await Promise.all([record.path, record.path.replace(/\.json$/, ".data")].map(path => fs.rm(path, { force: true })));
    }
  }
}
