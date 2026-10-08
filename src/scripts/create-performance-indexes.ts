import "dotenv/config";
import mongoose from "mongoose";
import config from "../config";
import Repository from "../core/model/anonymizedRepositories/anonymizedRepositories.model";
import Gist from "../core/model/anonymizedGists/anonymizedGists.model";
import PullRequest from "../core/model/anonymizedPullRequests/anonymizedPullRequests.model";
import File from "../core/model/files/files.model";
import Path from "../core/model/anonymized-path";
import Name from "../core/model/dashboard-name";

async function main() {
  const uri = config.MONGODB_URI || `mongodb://${config.DB_USERNAME}:${config.DB_PASSWORD}@${config.DB_HOSTNAME}:27017/production`;
  await mongoose.connect(uri, { autoIndex: false, ...(config.MONGODB_URI ? {} : { authSource: "admin" }) });
  // Additive only. Never use syncIndexes here, which can drop deployed indexes.
  await Repository.collection.createIndex({ "coauthors.githubId": 1 });
  await File.collection.createIndex({ repoId: 1, treeGeneration: 1, path: 1, name: 1 });
  await File.collection.createIndex({ metadataPending: 1, repoId: 1, treeGeneration: 1 },
    { partialFilterExpression: { metadataPending: true } });
  await Repository.collection.createIndex({ retiredTreeGenerations: 1 }, { sparse: true });
  await Repository.collection.createIndex({ retiredContentPrefixes: 1 }, { sparse: true });
  await Repository.collection.createIndex({ legacyContentCleanupPending: 1, status: 1 },
    { partialFilterExpression: { legacyContentCleanupPending: true } });
  // Register legacy cleanup once; ZIP roots remain the source of their files.
  await Repository.updateMany({ "source.type": { $ne: "Zip" }, contentCacheVersion: { $exists: false } },
    { $set: { contentCacheVersion: 1, legacyContentCleanupPending: true } }).exec();
  for (const model of [Repository, Gist, PullRequest]) {
    await model.collection.createIndex({ status: 1, "options.expirationDate": 1 });
  }
  await Repository.collection.createIndex({ status: 1, isReseted: 1, lastView: 1 });
  for (const model of [Path, Name]) await model.createIndexes();
  process.stdout.write("Performance indexes created. Existing indexes retained.\n");
}
main().catch(() => {
  process.stderr.write("Performance index creation failed; check database configuration and connectivity.\n");
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
