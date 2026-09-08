import { mongo } from "mongoose";
import { createTokenCipher, EncryptedToken } from "./credential-crypto";

type Cipher = ReturnType<typeof createTokenCipher>;
const resources = ["anonymizedrepositories", "anonymizedgists", "anonymizedpullrequests"];
const legacyQuery = { $or: [{ "source.accessToken": { $exists: true } }, { accessToken: { $exists: true } }] };
export interface MigrationOptions {
  apply?: boolean;
  removeLegacy?: boolean;
  preferOwnerToken?: boolean;
  batchSize?: number;
  report?: (event: { collection: string; id: string; issue: string }) => void;
}

/** Run with all application writers stopped. Reruns never replace an existing credential. */
export async function migrateCredentials(db: mongo.Db, cipher: Cipher, options: MigrationOptions = {}) {
  const credentials = db.collection("credentials");
  const users = db.collection("users");
  const batchSize = options.batchSize || 100;
  const counts = { owners: 0, created: 0, removed: 0, issues: 0 };
  const issue = (collection: string, id: unknown, reason: string) => {
    counts.issues++;
    options.report?.({ collection, id: String(id), issue: reason });
  };
  if (options.apply) await credentials.createIndex({ ownerId: 1, provider: 1 }, { unique: true });
  for await (const user of users.find({}, { projection: { accessTokens: 1, accessTokenDates: 1, status: 1 } }).batchSize(batchSize)) {
    counts.owners++;
    const ownerId = user._id;
    const existing = await credentials.findOne({ ownerId, provider: "github" });
    let selected: string | undefined;
    let valid = true;
    if (existing) {
      try { selected = cipher.decrypt(existing.encryptedToken as EncryptedToken, String(ownerId), "github"); }
      catch { issue("credentials", existing._id, "decryption_failed"); continue; }
    }
    const ownerToken = user.accessTokens?.github;
    const authoritative = !!(selected || (typeof ownerToken === "string" && ownerToken));
    const inspect = (value: unknown, collection: string, id: unknown) => {
      if (value === undefined || value === null || value === "") return;
      if (typeof value !== "string") {
        issue(collection, id, "malformed_token"); valid = false; return;
      }
      if (!selected) selected = value;
      else if (selected !== value && !(options.preferOwnerToken && authoritative)) {
        issue(collection, id, "conflicting_token"); valid = false;
      }
    };
    inspect(ownerToken, "users", ownerId);
    for (const name of resources) {
      for await (const row of db.collection(name).find({ owner: ownerId, ...legacyQuery }, {
        projection: { source: 1, accessToken: 1 },
      }).batchSize(batchSize)) {
        inspect(row.source?.accessToken, name, row._id);
        inspect(row.accessToken, name, row._id);
      }
    }
    if (!valid) continue;
    // Removed accounts must never regain credentials during backfill.
    if (user.status === "removed") {
      if (options.apply && options.removeLegacy) await credentials.deleteMany({ ownerId });
    } else if (selected && !existing) {
      const encryptedToken = cipher.encrypt(selected, String(ownerId), "github");
      if (cipher.decrypt(encryptedToken, String(ownerId), "github") !== selected) throw new Error("Credential verification failed");
      if (options.apply) {
        await credentials.updateOne({ ownerId, provider: "github" }, { $setOnInsert: {
          encryptedToken, updatedAt: user.accessTokenDates?.github || new Date(),
        } }, { upsert: true });
        const stored = await credentials.findOne({ ownerId, provider: "github" });
        if (!stored || cipher.decrypt(stored.encryptedToken as EncryptedToken, String(ownerId), "github") !== selected) {
          issue("users", ownerId, "credential_changed_retry"); continue;
        }
      }
      counts.created++;
    }
    if (options.apply && options.removeLegacy) {
      // The command requires maintenance mode: no login, refresh, deletion, or resource writes.
      const result = await users.updateOne({ _id: ownerId }, { $unset: { accessTokens: "", accessTokenDates: "" } });
      counts.removed += result.modifiedCount;
      for (const name of resources) {
        const result = await db.collection(name).updateMany({ owner: ownerId, ...legacyQuery }, {
          $unset: { "source.accessToken": "", accessToken: "" },
        });
        counts.removed += result.modifiedCount;
      }
    }
  }
  // Credentials attached to missing owners cannot be assigned safely.
  for (const name of resources) {
    for await (const row of db.collection(name).find(legacyQuery, { projection: { owner: 1 } }).batchSize(batchSize)) {
      if (!row.owner || !(await users.findOne({ _id: row.owner }, { projection: { _id: 1 } }))) {
        issue(name, row._id, "missing_owner");
      }
    }
  }
  return counts;
}

export async function verifyCredentials(db: mongo.Db, cipher: Cipher) {
  let checked = 0;
  for await (const row of db.collection("credentials").find({})) {
    cipher.decrypt(row.encryptedToken as EncryptedToken, String(row.ownerId), row.provider);
    if (!(await db.collection("users").findOne({ _id: row.ownerId, status: { $ne: "removed" } }))) {
      throw new Error("Credential has no active owner");
    }
    checked++;
  }
  let legacy = await db.collection("users").countDocuments({ accessTokens: { $exists: true } });
  for (const name of resources) legacy += await db.collection(name).countDocuments(legacyQuery);
  const pendingArchiveCleanup = await db.collection("anonymizedrepositories").countDocuments({ archiveCachePending: true });
  if (pendingArchiveCleanup) throw new Error("Archived repository cache cleanup is pending");
  return { checked, legacy };
}

/** Preserve existing validators while forbidding legacy credential storage. */
export async function enforceCredentialStorage(db: mongo.Db, cipher: Cipher) {
  const verification = await verifyCredentials(db, cipher);
  if (verification.legacy) throw new Error("Legacy credentials remain");
  for (const name of ["users", ...resources]) {
    const info = await db.listCollections({ name }).next();
    if (!info) await db.createCollection(name);
    const previous = info && "options" in info ? info.options?.validator : undefined;
    const absent = name === "users" ? { accessTokens: { $exists: false } } : {
      "source.accessToken": { $exists: false }, accessToken: { $exists: false },
    };
    await db.command({ collMod: name, validator: previous && Object.keys(previous).length ? {
      $and: [previous, absent],
    } : absent, validationLevel: "strict", validationAction: "error" });
  }
  return verification;
}
