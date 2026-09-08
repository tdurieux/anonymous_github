import "dotenv/config";
import mongoose from "mongoose";
import config from "../config";
import { recoverRepositoryOwners } from "../core/recover-repository-owners";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  let repositoryId: mongoose.mongo.ObjectId | undefined;
  for (const arg of args) {
    if (arg.startsWith("--id=") && /^[a-f0-9]{24}$/i.test(arg.slice(5))) {
      repositoryId = new mongoose.mongo.ObjectId(arg.slice(5));
    } else if (arg !== "--apply" && arg !== "--maintenance") {
      process.stderr.write("Usage: recover-repository-owners.js [--id=<MongoDB document ID>] [--apply --maintenance]\n");
      process.exitCode = 1;
      return;
    }
  }
  if (apply && !args.includes("--maintenance")) {
    process.stderr.write("Stop application writers and pass --maintenance to assign owners.\n");
    process.exitCode = 1;
    return;
  }
  const uri = config.MONGODB_URI || `mongodb://${config.DB_USERNAME}:${config.DB_PASSWORD}@${config.DB_HOSTNAME}:27017/production`;
  await mongoose.connect(uri, { ...(config.MONGODB_URI ? {} : { authSource: "admin" }), autoIndex: false });
  const counts = await recoverRepositoryOwners(mongoose.connection.db, {
    apply, repositoryId,
    report: event => process.stdout.write(JSON.stringify(event) + "\n"),
  });
  process.stdout.write(JSON.stringify(counts) + "\n");
  if (counts.issues || counts.halted) process.exitCode = 1;
}
main().catch(() => {
  process.stderr.write("Owner recovery failed. Check database connectivity/configuration; no token values or request errors are logged.\n");
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
