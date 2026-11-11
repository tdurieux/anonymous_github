import "dotenv/config";
import mongoose, { mongo } from "mongoose";
import config from "../config";

const candidates = [
  { name: "path_1", key: { path: 1 } },
  { name: "path_1_repoId_1", key: { path: 1, repoId: 1 } },
  { name: "repoIDAndPath", key: { repoId: 1, path: 1 } },
];
const replacementKey = { repoId: 1, treeGeneration: 1, path: 1, name: 1 };

/** Operator-controlled retirement: hide first, observe traffic, then drop. */
export async function retireFileIndexes(db: mongo.Db, action: string) {
  if (!["status", "hide", "restore", "drop"].includes(action)) throw Error("Use status, hide, restore or drop");
  const collection = db.collection("files");
  const indexes = await collection.listIndexes().toArray();
  const selected = candidates.flatMap(candidate => {
    const index = indexes.find(index => index.name === candidate.name);
    if (!index) return [];
    if (JSON.stringify(index.key) !== JSON.stringify(candidate.key) || index.unique || index.sparse ||
        index.partialFilterExpression || index.collation || index.expireAfterSeconds !== undefined) {
      throw Error(`Unexpected definition for ${candidate.name}; refusing retirement`);
    }
    return [index];
  });
  if (action === "hide" || action === "drop") {
    if (!indexes.some(index => JSON.stringify(index.key) === JSON.stringify(replacementKey) && !index.hidden &&
        !index.partialFilterExpression && !index.sparse && !index.collation && !index.buildUUID)) {
      throw Error("The generation/path replacement index must be ready and visible");
    }
  }
  // Validate every candidate before changing any of them.
  if (action === "drop" && selected.some(index => !index.hidden)) throw Error("Hide all candidate indexes and observe traffic before dropping them");
  for (const index of selected) {
    if (action === "drop") await collection.dropIndex(index.name!);
    else if (action === "hide" || action === "restore") {
      await db.command({ collMod: "files", index: { name: index.name, hidden: action === "hide" } });
    }
  }
  return selected.map(index => ({ name: index.name, action, previouslyHidden: !!index.hidden }));
}

async function main() {
  const uri = config.MONGODB_URI || `mongodb://${encodeURIComponent(config.DB_USERNAME)}:${encodeURIComponent(config.DB_PASSWORD)}@${config.DB_HOSTNAME}:27017/production`;
  await mongoose.connect(uri, { autoIndex: false, ...(config.MONGODB_URI ? {} : { authSource: "admin" }) });
  console.log(await retireFileIndexes(mongoose.connection.db!, process.argv[2] || "status"));
}
if (require.main === module) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Index retirement failed"); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
}
