import { mongo } from "mongoose";
import { setImmediate } from "timers/promises";
import { createLogger } from "./logger";

export const FILE_TREE_BATCH_SIZE = 500;
// A folder response must fit in memory alongside other API requests.
export const FILE_LISTING_LIMIT = 10000;
const logger = createLogger("file-tree");

/** Keep each Mongo write bounded, and let other work run between batches. */
export async function deleteRowsInBatches(
  collection: Pick<mongo.Collection, "find" | "deleteMany">,
  filter: mongo.Filter<mongo.Document> & { repoId: string },
  options: { maxBatches?: number; current?: () => Promise<boolean> } = {}
): Promise<boolean> {
  const started = Date.now();
  let deleted = 0;
  for (let batch = 0; batch < (options.maxBatches ?? Infinity); batch++) {
    if (options.current && !await options.current()) return false;
    const rows = await collection.find(filter, { projection: { _id: 1 }, limit: FILE_TREE_BATCH_SIZE }).toArray();
    if (!rows.length) {
      if (deleted) logger.info("metadata cleanup complete", { repoId: filter.repoId, deleted, ms: Date.now() - started });
      return true;
    }
    if (options.current && !await options.current()) return false;
    const result = await collection.deleteMany({ ...filter, _id: { $in: rows.map(row => row._id) } }, { hint: "_id_" });
    deleted += result.deletedCount;
    await setImmediate();
  }
  logger.info("metadata cleanup deferred", { repoId: filter.repoId, deleted, ms: Date.now() - started });
  return false;
}

/** Staging markers are bookkeeping; leave the remainder discoverable by maintenance. */
export async function clearStagedRowsInBatches(
  collection: Pick<mongo.Collection, "find" | "updateMany">,
  repoId: string, treeGeneration: string, maxBatches = 10
): Promise<void> {
  const filter = { repoId, treeGeneration, treeStaged: true };
  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = await collection.find(filter, { projection: { _id: 1 }, limit: FILE_TREE_BATCH_SIZE }).toArray();
    if (!rows.length) return;
    await collection.updateMany({ ...filter, _id: { $in: rows.map(row => row._id) } },
      { $unset: { treeStaged: "" } }, { hint: "_id_" });
    await setImmediate();
  }
}
