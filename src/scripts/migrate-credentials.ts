import "dotenv/config";
import mongoose from "mongoose";
import config from "../config";
import { credentialCipher } from "../core/credentials";
import { migrateCredentials, verifyCredentials, enforceCredentialStorage } from "../core/migrate-credentials";

async function main() {
  const args = new Set(process.argv.slice(2));
  const concurrencyArgs = [...args].filter(arg => arg.startsWith("--concurrency="));
  if (concurrencyArgs.length > 1) throw new Error("Specify concurrency once");
  const concurrency = concurrencyArgs.length ? Number(concurrencyArgs[0].slice("--concurrency=".length)) : 10;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("Concurrency must be 1..32");
  for (const arg of args) {
    if (concurrencyArgs.includes(arg)) continue;
    if (!["--apply", "--remove-legacy", "--prefer-owner-token", "--recover-owner-tokens", "--maintenance", "--verify", "--enforce"].includes(arg)) {
      throw new Error("Unknown migration option");
    }
  }
  if (args.has("--apply") && !args.has("--maintenance")) throw new Error("Stop all application writers and pass --maintenance before applying");
  if (args.has("--enforce") && !args.has("--apply")) throw new Error("--enforce requires --apply");
  if (args.has("--remove-legacy") && !args.has("--apply")) throw new Error("--remove-legacy requires --apply");
  const cipher = credentialCipher();
  const uri = config.MONGODB_URI || `mongodb://${config.DB_USERNAME}:${config.DB_PASSWORD}@${config.DB_HOSTNAME}:27017/production`;
  await mongoose.connect(uri, config.MONGODB_URI ? {} : { authSource: "admin" });
  const db = mongoose.connection.db;
  if (args.has("--enforce")) {
    process.stdout.write(JSON.stringify(await enforceCredentialStorage(db, cipher)) + "\n");
  } else if (args.has("--verify")) {
    const result = await verifyCredentials(db, cipher);
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.legacy) process.exitCode = 1;
  } else {
    const result = await migrateCredentials(db, cipher, {
      concurrency,
      apply: args.has("--apply"), removeLegacy: args.has("--remove-legacy"),
      preferOwnerToken: args.has("--prefer-owner-token"),
      recoverOwnerTokens: args.has("--recover-owner-tokens"),
      report: event => process.stdout.write(JSON.stringify(event) + "\n"),
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.issues) process.exitCode = 1;
  }
}
main().catch(() => {
  // Driver errors can contain document values or connection credentials.
  process.stderr.write("Credential migration failed; check configuration, connectivity, and encrypted records. No secret values are logged.\n");
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
