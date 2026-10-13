import mongoose from "mongoose";
import config from "../config";
import { getMongoUrl } from "../server/database";
import { prepareLegacyOwnerAlertMigration } from "../core/owner-notifications";

async function main(): Promise<void> {
  await mongoose.connect(getMongoUrl(), config.MONGODB_URI ? {} : { authSource: "admin" });
  try {
    await prepareLegacyOwnerAlertMigration();
    process.stdout.write("Legacy owner alert reconciliation prepared\n");
  } finally { await mongoose.disconnect(); }
}

void main().catch(() => {
  process.stderr.write("Could not prepare legacy owner alert reconciliation\n");
  process.exitCode = 1;
});
