import { createHash, randomUUID } from "crypto";
import { mongo, Types } from "mongoose";
import { isGitHubRateLimitError } from "./github-rate-limit";
import config from "../config";
import UserModel from "./model/users/users.model";
import { createLogger } from "./logger";

const logger = createLogger("owner-notifications");
const resourceCollections = {
  repository: "anonymizedrepositories",
  "pull-request": "anonymizedpullrequests",
  gist: "anonymizedgists",
} as const;
export interface AlertResource { kind: keyof typeof resourceCollections; id: string; }

// Only explicit owner actions call this; background fetches never reset alerts.
export async function resetOwnerAccessAlerts(ownerId: string, resource?: AlertResource): Promise<void> {
  if (UserModel.db.readyState !== 1 || !Types.ObjectId.isValid(ownerId)) return;
  try {
    const filter = { owner: new Types.ObjectId(ownerId),
      ...(resource ? { _id: new Types.ObjectId(resource.id) } : {}) };
    const claim = { owner: new Types.ObjectId(ownerId),
      ...(resource ? { resourceKind: resource.kind, resourceId: new Types.ObjectId(resource.id) } : {}) };
    await alertCollection().updateMany({ $or: [claim, { legacyClaims: { $elemMatch: claim } }] }, { $inc: { resetRevision: 1 } });
    for (const collection of resource ? [resourceCollections[resource.kind]] : Object.values(resourceCollections)) {
      await UserModel.db.collection(collection).updateMany(filter, { $unset: { accessAlertClaimedAt: "" }, $set: { accessAlertGeneration: randomUUID() } });
    }
  } catch { logger.warn("owner access alert reset unavailable"); }
}
export const RECIPIENT_ALERTS = "owner_access_alert_recipients";
type LegacyClaim = { owner: Types.ObjectId; resourceKind: AlertResource["kind"]; resourceId: Types.ObjectId; generation: string | null };
type AlertRecord = { _id: string; state?: string; lease?: string; leaseUntil?: Date;
  owner?: Types.ObjectId; resourceKind?: string; resourceId?: Types.ObjectId;
  generation?: string | null; attemptId?: string; claimedAt?: Date; completedAt?: Date;
  recipientKey?: string; resetRevision?: number; httpStatus?: number; startedAt?: Date;
  progress?: Record<string, { claimedAt: Date; id: Types.ObjectId }>; legacyClaims?: LegacyClaim[] };
const alertCollection = (name = RECIPIENT_ALERTS) => UserModel.db.collection(name) as unknown as mongo.Collection<AlertRecord>;
const MIGRATION = "recipient-alerts-v1";
const PENDING_LEASE_MS = 60000;
const expiredPending = () => ({ state: "pending", claimedAt: { $lte: new Date(Date.now() - PENDING_LEASE_MS) } });
const generationFilter = (generation: unknown) => generation ?? { $exists: false };
export const recipientAlertKey = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

/** Seed the recipient guard once before any new application instance serves traffic. */
export async function initializeOwnerAccessAlerts(): Promise<void> {
  const alerts = alertCollection();
  await alerts.createIndex({ owner: 1, resourceKind: 1, resourceId: 1 });
  await alerts.createIndex({ "legacyClaims.owner": 1, "legacyClaims.resourceKind": 1, "legacyClaims.resourceId": 1 });
  await alerts.createIndex({ claimedAt: 1 }, { name: "owner_access_alert_pending", partialFilterExpression: { state: "pending" } });
  try { await alerts.updateOne({ _id: MIGRATION }, { $setOnInsert: { state: "new" } }, { upsert: true }); }
  catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
  const lease = randomUUID();
  for (;;) {
    if ((await alerts.findOne({ _id: MIGRATION }))?.state === "ready") {
      await alerts.deleteMany(expiredPending());
      return;
    }
    const now = new Date();
    const claim = await alerts.updateOne({ _id: MIGRATION, state: { $ne: "ready" },
      $or: [{ leaseUntil: { $lt: now } }, { leaseUntil: { $exists: false } }],
    }, { $set: { lease, leaseUntil: new Date(Date.now() + 60000) } });
    if (!claim.modifiedCount) { await new Promise(resolve => setTimeout(resolve, 250)); continue; }
    let heartbeatError: unknown;
    const heartbeat = setInterval(() => {
      void alerts.updateOne({ _id: MIGRATION, lease }, { $set: { leaseUntil: new Date(Date.now() + 60000) } })
        .then(result => { if (!result.matchedCount) heartbeatError = new Error("owner_alert_migration_lease_lost"); })
        .catch(error => { heartbeatError = error; });
    }, 5000);
    try {
      for (const [kind, name] of Object.entries(resourceCollections)) {
        const resources = UserModel.db.collection(name);
        const index = "owner_access_alert_backfill";
        await resources.createIndex({ accessAlertClaimedAt: 1, _id: 1 },
          { name: index, partialFilterExpression: { accessAlertClaimedAt: { $exists: true } } });
        const checkpoint = (await alerts.findOne({ _id: MIGRATION, lease }))?.progress?.[kind];
        const filter = { accessAlertClaimedAt: { $exists: true }, ...(checkpoint ? { $or: [
          { accessAlertClaimedAt: { $gt: checkpoint.claimedAt } },
          { accessAlertClaimedAt: checkpoint.claimedAt, _id: { $gt: checkpoint.id } },
        ] } : {}) };
        const cursor = resources.find(filter,
          { projection: { owner: 1, accessAlertGeneration: 1, accessAlertClaimedAt: 1 } })
          .sort({ accessAlertClaimedAt: 1, _id: 1 }).hint(index).batchSize(100);
        let count = 0;
        let last: { claimedAt: Date; id: Types.ObjectId } | undefined;
        const saveProgress = async () => {
          if (!last) return;
          const saved = await alerts.updateOne({ _id: MIGRATION, lease }, { $set: { [`progress.${kind}`]: last } });
          if (!saved.matchedCount) throw new Error("owner_alert_migration_lease_lost");
        };
        for await (const row of cursor) {
          if (heartbeatError) throw heartbeatError;
          last = { claimedAt: row.accessAlertClaimedAt, id: row._id };
          const owner = await UserModel.findById(row.owner).select("emails notificationEmail status").lean();
          const email = notificationEmail(owner?.emails, owner?.notificationEmail);
          const legacyClaim: LegacyClaim = { owner: row.owner, resourceKind: kind as AlertResource["kind"],
            resourceId: row._id, generation: row.accessAlertGeneration ?? null };
          if (email && owner && !["removed", "banned"].includes(owner.status || "")) await alerts.updateOne({ _id: recipientAlertKey(email) }, { $setOnInsert: {
            ...legacyClaim, attemptId: randomUUID(),
            claimedAt: row.accessAlertClaimedAt, state: "legacy",
          }, $addToSet: { legacyClaims: legacyClaim } }, { upsert: true });
          if (++count % 100 === 0) await saveProgress();
        }
        await saveProgress();
      }
      if (heartbeatError) throw heartbeatError;
      const completed = await alerts.updateOne({ _id: MIGRATION, lease }, { $set: { state: "ready" }, $unset: { lease: "", leaseUntil: "" } });
      if (!completed.matchedCount) throw new Error("owner_alert_migration_lease_lost");
      await alerts.deleteMany(expiredPending());
      return;
    } finally { clearInterval(heartbeat); }
  }
}

/** Only a fresh upstream read after owner action may reopen a recipient alert. */
export async function withOwnerAccessRecovery<T>(ownerId: string, resource: AlertResource, work: () => Promise<T>, expectedSource: Record<string, unknown> = {}, confirmed: (result: T) => boolean = () => true): Promise<T> {
  let snapshot: { accessAlertGeneration?: string } | null = null;
  let candidates: AlertRecord[] = [];
  const valid = UserModel.db.readyState === 1 && Types.ObjectId.isValid(ownerId) && Types.ObjectId.isValid(resource.id);
  const identity = valid ? { _id: new Types.ObjectId(resource.id), owner: new Types.ObjectId(ownerId), ...expectedSource } : null;
  if (identity) {
    try {
      const row = await UserModel.db.collection(resourceCollections[resource.kind]).findOne(identity, { projection: { accessAlertGeneration: 1 } });
      snapshot = row ? { accessAlertGeneration: row.accessAlertGeneration } : null;
      if (snapshot) {
        const claim = { owner: identity.owner, resourceKind: resource.kind, resourceId: identity._id,
          generation: { $ne: snapshot.accessAlertGeneration ?? null } };
        candidates = await alertCollection().find({ state: { $in: ["pending", "accepted", "failed", "legacy"] },
          $or: [{ ...claim, legacyClaims: { $exists: false } }, { legacyClaims: { $elemMatch: claim } }],
        }).toArray();
      }
    }
    catch { /* Email bookkeeping must not change upstream behavior. */ }
  }
  const result = await work();
  if (!identity || !snapshot || !confirmed(result)) return result;
  try {
    const current = await UserModel.db.collection(resourceCollections[resource.kind]).findOne({ ...identity,
      accessAlertGeneration: generationFilter(snapshot.accessAlertGeneration),
    });
    if (!current) return result;
    let cleared = 0;
    for (const candidate of candidates) {
      const fence = { _id: candidate._id, attemptId: candidate.attemptId, resetRevision: generationFilter(candidate.resetRevision),
        state: { $in: ["pending", "accepted", "failed", "legacy"] } };
      if (candidate.legacyClaims) {
        await alertCollection().updateOne(fence, { $pull: { legacyClaims: { owner: identity.owner,
          resourceKind: resource.kind, resourceId: identity._id, generation: { $ne: snapshot.accessAlertGeneration ?? null } } } });
      }
      const result = await alertCollection().deleteOne({ ...fence, ...(candidate.legacyClaims ? { legacyClaims: { $size: 0 } } : {}) });
      cleared += result.deletedCount;
    }
    if (cleared) logger.info("owner access email recovery confirmed", { cleared });
  } catch { logger.warn("owner access email recovery unavailable"); }
  return result;
}

const accessErrors = new Set([
  "token_expired", "github_oauth_required", "github_app_reconnect_required",
  "github_app_access_required", "repo_not_found", "repository_not_found",
  "file_not_accessible", "file_not_found", "pull_request_not_found", "gist_not_found", "repo_not_accessible", "repo_access_limited", "repo_saml_enforcement",
]);

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  // Accept one plain mailbox, never a display name or recipient list.
  if (email.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(email)) return null;
  const local = email.split("@")[0];
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || email.includes("..")) return null;
  return email;
}

export function notificationEmail(emails?: { email: string; default: boolean }[], preferred?: string): string {
  return normalizeEmail(preferred) || normalizeEmail(emails?.find(e => e.default)?.email) ||
    emails?.map(e => normalizeEmail(e.email)).find(Boolean) || "";
}

export function isAccessFailure(error: unknown): boolean {
  if (isGitHubRateLimitError(error)) return false;
  const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const rawStatus = error instanceof Error ? (error as Error & { status?: number }).status : undefined;
  if (!accessErrors.has(code) && ![401, 403, 404].includes(rawStatus || 0)) return false;
  if (error instanceof Error) {
    const upstream = (error as Error & { cause?: { status?: number; httpStatus?: number; response?: { statusCode?: number } } }).cause;
    // Some legacy paths wrap timeouts or 5xx responses as repo_not_found.
    // Only a confirmed access failure should prompt the owner to reconnect.
    if (isGitHubRateLimitError(upstream)) return false;
    if (upstream && ![401, 403, 404].includes(upstream.status || upstream.response?.statusCode || upstream.httpStatus || 0)) return false;
    const status = (error as Error & { httpStatus?: number }).httpStatus;
    if (status && (status === 429 || status >= 500)) return false;
  }
  return true;
}

/** Best effort; mail and database failures must not change repository behavior. */
export async function notifyOwnerAccessProblem(ownerId: string, error: unknown, resource: AlertResource): Promise<void> {
  if (!config.RESEND_API_KEY || !config.EMAIL_FROM || !isAccessFailure(error)) return;
  let unsent: { key: string; attemptId: string } | undefined;
  let providerStarted = false;
  try {
    if (!resource || !Types.ObjectId.isValid(resource.id) || !Types.ObjectId.isValid(ownerId)) return;
    const collection = UserModel.db.collection(resourceCollections[resource.kind]);
    const identity = { _id: new Types.ObjectId(resource.id), owner: new Types.ObjectId(ownerId) };
    const snapshot = await collection.findOne(identity, { projection: { accessAlertGeneration: 1, accessAlertClaimedAt: 1 } });
    if (!snapshot) return;
    const owner = await UserModel.findOne({ _id: ownerId, status: { $nin: ["removed", "banned"] } }).lean();
    if (!owner) return;
    const to = notificationEmail(owner.emails, owner.notificationEmail);
    if (!to) return;
    const alerts = alertCollection();
    const key = recipientAlertKey(to);
    const attemptId = randomUUID();
    const record: AlertRecord = { _id: key, owner: identity.owner, resourceKind: resource.kind,
      resourceId: identity._id, generation: snapshot.accessAlertGeneration ?? null,
      attemptId, claimedAt: new Date(), state: "pending" };
    unsent = { key, attemptId };
    try { await alerts.insertOne(record); }
    catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      unsent = undefined;
      const previous = await alerts.findOne({ _id: key });
      if (!previous || previous.state === "sending" || !previous.owner || !previous.resourceId
        || !previous.resourceKind || !(previous.resourceKind in resourceCollections)) return;
      let retirement: mongo.Filter<AlertRecord> = { _id: key, attemptId: previous.attemptId, state: previous.state };
      if (previous.state === "pending") {
        if (!previous.claimedAt || previous.claimedAt.getTime() > Date.now() - PENDING_LEASE_MS) return;
        retirement = { ...retirement, ...expiredPending() };
      } else {
        const claims = previous.legacyClaims ?? [previous as LegacyClaim];
        for (const claim of claims) {
          const previousResource = await UserModel.db.collection(resourceCollections[claim.resourceKind]).findOne(
            { _id: claim.resourceId, owner: claim.owner }, { projection: { status: 1 } });
          const previousOwner = await UserModel.findById(claim.owner).select("status").lean();
          if (previousOwner && !["banned", "removed"].includes(previousOwner.status || "")
            && previousResource && !["removed", "expired"].includes(previousResource.status)) return;
        }
        if (previous.legacyClaims) retirement.legacyClaims = previous.legacyClaims;
      }
      const retired = await alerts.deleteOne(retirement);
      if (!retired.deletedCount) return;
      unsent = { key, attemptId };
      try { await alerts.insertOne(record); }
      catch (replacementError) { if ((replacementError as { code?: number }).code === 11000) { unsent = undefined; return; } throw replacementError; }
    }
    const claim = await collection.updateOne({ ...identity,
      accessAlertGeneration: generationFilter(snapshot.accessAlertGeneration),
    }, { $set: { accessAlertClaimedAt: new Date() } });
    if (!claim.matchedCount || !await collection.findOne({ ...identity,
      accessAlertGeneration: generationFilter(snapshot.accessAlertGeneration),
    })) {
      await alerts.deleteOne({ _id: key, attemptId, state: "pending" });
      return;
    }
    const base = /^https?:\/\//.test(config.APP_HOSTNAME) ? config.APP_HOSTNAME : `https://${config.APP_HOSTNAME}`;
    const url = new URL("/connections", base).href;
    await alertCollection("owner_access_alert_events").insertOne({ _id: attemptId, attemptId,
      recipientKey: key, state: "prepared", startedAt: new Date() });
    // Recovery can cancel an unsent claim; only its owner may begin dispatch.
    const dispatch = await alerts.updateOne({ _id: key, attemptId, state: "pending" }, { $set: { state: "sending" } });
    if (!dispatch.matchedCount) return;
    let accepted = false;
    let httpStatus: number | undefined;
    try {
      providerStarted = true;
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json",
          "Idempotency-Key": `owner-access-alert/${attemptId}` },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          from: config.EMAIL_FROM, to: [to],
          subject: "Your Anonymous GitHub connection needs attention",
          text: `Anonymous GitHub could not access GitHub using your connection, or could not read a repository.\n\nOpen your connections page to reconnect your account or restore repository access:\n${url}\n\nYou are receiving this email because you own content on Anonymous GitHub. You can change your alert address on the connections page.\n`,
        }),
      });
      httpStatus = response.status;
      accepted = response.ok;
    } catch { /* Delivery can be ambiguous; retain the recipient guard. */ }
    const state = accepted ? "accepted" : "failed";
    if (accepted) logger.info("owner access email accepted", { attemptId, httpStatus });
    else logger.warn("owner access email delivery failed", { attemptId, httpStatus });
    try {
      await alerts.updateOne({ _id: key, attemptId }, { $set: { state, completedAt: new Date(), httpStatus } });
      await alertCollection("owner_access_alert_events").insertOne({ _id: `${attemptId}/completion`, attemptId,
        recipientKey: key, state, httpStatus, completedAt: new Date() });
    } catch { logger.warn("owner access email audit unavailable", { attemptId }); }
  } catch {
    logger.warn("owner access email unavailable");
  } finally {
    if (unsent && !providerStarted) {
      await alertCollection().deleteOne({ _id: unsent.key, attemptId: unsent.attemptId,
        state: { $in: ["pending", "sending"] } }).catch(() => logger.warn("owner access email claim cleanup unavailable"));
    }
  }
}
