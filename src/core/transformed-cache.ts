import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash, randomUUID } from "crypto";
import config from "../config";
import { coordinatedFill } from "./cache-coordination";
import { isConnected } from "../server/database";
import RepositoryModel from "./model/anonymizedRepositories/anonymizedRepositories.model";
import { RepositoryStatus } from "./types";
import AnonymousError from "./AnonymousError";
const root = join(tmpdir(), "anonymous-transformed-v1");
const TTL = 3600_000;
const DISK_BUDGET = 512 * 1024 * 1024;
const fills = new Map<string, Promise<boolean>>();
interface CacheScope { repoId: string; generation?: string; revision?: string }

async function scopeActive(scope?: CacheScope) {
  if (!scope || !isConnected) return true;
  const current = await RepositoryModel.findOne({ repoId: scope.repoId })
    .select("status treeGeneration anonymizeDate contentCacheRevision").lean().exec();
  return !!current?.status && ![RepositoryStatus.EXPIRING, RepositoryStatus.EXPIRED,
    RepositoryStatus.REMOVING, RepositoryStatus.REMOVED, RepositoryStatus.ARCHIVED].includes(current.status)
    && (!scope.generation || scope.generation === `${current.treeGeneration || "legacy"}:${current.anonymizeDate?.toISOString() || ""}`)
    && scope.revision === current.contentCacheRevision;
}

async function removeEntry(metadata: string) {
  await Promise.all([metadata, metadata.replace(/\.json$/, ".data")].map(path => fs.rm(path, { force: true })));
}

/** The key includes actual content, all rules, generation, and matcher version. */
export async function transformedFile(digest: string, options: unknown, output: string,
  produce: () => Promise<boolean>): Promise<boolean> {
  const settings = options as { repoId?: string; cacheGeneration?: string; cacheRevision?: string } | undefined;
  const scope: CacheScope | undefined = typeof settings?.repoId === "string"
    ? { repoId: settings.repoId, generation: settings.cacheGeneration, revision: settings.cacheRevision } : undefined;
  const assertActive = async () => {
    if (!await scopeActive(scope)) throw new AnonymousError("repository_changed", { httpStatus: 409 });
  };
  const produceActive = async () => {
    await assertActive();
    const changed = await produce();
    try { await assertActive(); }
    catch (error) { await fs.rm(output, { force: true }); throw error; }
    return changed;
  };
  await assertActive();
  const key = createHash("sha256").update(JSON.stringify(["matcher-v1", digest, options,
    config.ANONYMIZATION_MASK, config.APP_HOSTNAME])).digest("hex");
  const data = join(root, `${key}.data`), metadata = join(root, `${key}.json`);
  const read = async () => {
    try {
      const record = JSON.parse(await fs.readFile(metadata, "utf8"));
      if (record.version !== 2 || Date.now() - record.created > TTL || (await fs.stat(data)).size !== record.size) return undefined;
      return Boolean(record.changed);
    } catch { return undefined; }
  };
  const copyCached = async (changed: boolean) => {
    await fs.copyFile(data, output, fs.constants.COPYFILE_EXCL);
    try { await assertActive(); } catch (error) { await fs.rm(output, { force: true }); throw error; }
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
  if (fills.size >= 64) return produceActive();
  let producedHere = false;
  const task = coordinatedFill(`transformed:${key}`, read, async () => {
    const changed = await produceActive();
    producedHere = true;
    const size = (await fs.stat(output)).size;
    if (size > DISK_BUDGET / 4) return changed;
    const token = randomUUID();
    const tempData = `${data}.${token}.tmp`, tempMetadata = `${metadata}.${token}.tmp`;
    try {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.copyFile(output, tempData);
      await fs.writeFile(tempMetadata, JSON.stringify({ version: 2, changed, size, created: Date.now(), scope }));
      await fs.rename(tempData, data);
      await fs.rename(tempMetadata, metadata);
      await pruneTransformedCache(false);
    } catch { /* A valid private output remains usable when cache storage fails. */
    } finally {
      await Promise.all([tempData, tempMetadata].map(path => fs.rm(path, { force: true }).catch(() => {})));
    }
    try { await assertActive(); }
    catch (error) { await removeEntry(metadata); await fs.rm(output, { force: true }); throw error; }
    return changed;
  });
  fills.set(key, task);
  try {
    const changed = await task;
    if (producedHere) return changed;
    try { return await copyCached(changed); } catch { return produceActive(); }
  } finally { if (fills.get(key) === task) fills.delete(key); }
}
export async function pruneTransformedCache(validateLifecycle = true) {
  const records = [];
  let lifecycleError: Error | undefined;
  let entries;
  try { entries = await fs.opendir(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for await (const entry of entries) {
    const name = entry.name;
    if (name.endsWith(".tmp") || name.endsWith(".data")) {
      const path = join(root, name);
      try { if (Date.now() - (await fs.stat(path)).mtimeMs > TTL) await fs.rm(path, { force: true }); } catch { /* another publisher */ }
    }
    if (!name.endsWith(".json")) continue;
    const path = join(root, name);
    let record;
    try { record = JSON.parse(await fs.readFile(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") await removeEntry(path); continue; }
    if (record.version !== 2 || !Number.isFinite(record.created) || !Number.isFinite(record.size)
      || Date.now() - record.created > TTL) { await removeEntry(path); continue; }
    if (validateLifecycle && !lifecycleError) {
      try { if (!await scopeActive(record.scope)) { await removeEntry(path); continue; } }
      catch (error) { lifecycleError = error as Error; }
    }
    records.push({ path, ...record });
  }
  records.sort((a, b) => b.created - a.created);
  let bytes = 0;
  for (let i = 0; i < records.length; i++) {
    const record = records[i]; bytes += record.size;
    if (i >= 128 || bytes > DISK_BUDGET || Date.now() - record.created > TTL) {
      await removeEntry(record.path);
    }
  }
  // Storage age and budget cleanup must finish even when MongoDB is unavailable.
  if (lifecycleError) throw lifecycleError;
}

/** Lifecycle changes remove local entries; connected replicas also prune independently. */
export async function removeTransformedRepositoryCache(repoId: string) {
  let entries;
  try { entries = await fs.opendir(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for await (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const metadata = join(root, entry.name);
    let record;
    try { record = JSON.parse(await fs.readFile(metadata, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") await removeEntry(metadata); continue; }
    if (record.version !== 2 || record.scope?.repoId === repoId) await removeEntry(metadata);
  }
}
