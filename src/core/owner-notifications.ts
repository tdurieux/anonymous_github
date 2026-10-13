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
    await alertCollection().updateMany({ ...claim, legacyClaims: { $exists: false } }, { $inc: { resetRevision: 1 } });
    await alertCollection().updateMany({ legacyClaims: { $elemMatch: claim } }, [{ $set: {
      resetRevision: { $add: [{ $ifNull: ["$resetRevision", 0] }, 1] },
      legacyClaims: { $map: { input: "$legacyClaims", as: "claim", in: { $cond: [
        { $and: Object.entries(claim).map(([key, value]) => ({ $eq: [`$$claim.${key}`, value] })) },
        { $mergeObjects: ["$$claim", { recovered: false }] }, "$$claim",
      ] } } },
      state: { $cond: [{ $eq: ["$state", "recovered"] }, "legacy", "$state"] },
    } }]);
    for (const collection of resource ? [resourceCollections[resource.kind]] : Object.values(resourceCollections)) {
      await UserModel.db.collection(collection).updateMany(filter, { $unset: { accessAlertClaimedAt: "" }, $set: { accessAlertGeneration: randomUUID() } });
    }
  } catch { logger.warn("owner access alert reset unavailable"); }
}
export const RECIPIENT_ALERTS = "owner_access_alert_recipients";
type LegacyClaim = { owner: Types.ObjectId; resourceKind: AlertResource["kind"]; resourceId: Types.ObjectId; generation: string | null; recovered?: boolean };
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

/** Call only after all legacy application writers have stopped. */
export async function prepareLegacyOwnerAlertMigration(): Promise<void> {
  await alertCollection().updateOne({ _id: MIGRATION }, { $set: { state: "new" },
    $unset: { progress: "", lease: "", leaseUntil: "" } }, { upsert: true });
}

async function reconcileCompletedSend(record: AlertRecord): Promise<void> {
  if (record.state !== "sending" || !record.attemptId) return;
  const completion = await alertCollection("owner_access_alert_events").findOne({ _id: `${record.attemptId}/completion` });
  if (!completion || !["accepted", "failed"].includes(completion.state || "")) return;
  await alertCollection().updateOne({ _id: record._id, attemptId: record.attemptId, state: "sending" },
    { $set: { state: completion.state, completedAt: completion.completedAt, httpStatus: completion.httpStatus } });
}

async function reconcileCompletedSends(): Promise<void> {
  for await (const record of alertCollection().find({ state: "sending" })) await reconcileCompletedSend(record);
}

async function retryAlertWrite(work: () => Promise<unknown>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await work(); return; }
    catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** Seed the recipient guard once before any new application instance serves traffic. */
export async function initializeOwnerAccessAlerts(): Promise<void> {
  const alerts = alertCollection();
  await alerts.createIndex({ owner: 1, resourceKind: 1, resourceId: 1 });
  await alerts.createIndex({ "legacyClaims.owner": 1, "legacyClaims.resourceKind": 1, "legacyClaims.resourceId": 1 });
  await alerts.createIndex({ claimedAt: 1 }, { name: "owner_access_alert_pending", partialFilterExpression: { state: "pending" } });
  await alerts.createIndex({ state: 1 });
  try { await alerts.updateOne({ _id: MIGRATION }, { $setOnInsert: { state: "new" } }, { upsert: true }); }
  catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
  const lease = randomUUID();
  for (;;) {
    if ((await alerts.findOne({ _id: MIGRATION }))?.state === "ready") {
      await reconcileCompletedSends();
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
            resourceId: row._id, generation: row.accessAlertGeneration ?? null, recovered: false };
          if (email && owner && !["removed", "banned"].includes(owner.status || "")) {
            const key = recipientAlertKey(email);
            const previous = await alerts.findOne({ _id: key });
            const claims = [legacyClaim];
            if (previous && !previous.legacyClaims && previous.owner && previous.resourceKind && previous.resourceId) {
              claims.push({ owner: previous.owner, resourceKind: previous.resourceKind as AlertResource["kind"],
                resourceId: previous.resourceId, generation: previous.generation ?? null, recovered: false });
            }
            await alerts.updateOne({ _id: key, legacyClaims: { $elemMatch: { owner: legacyClaim.owner,
              resourceKind: legacyClaim.resourceKind, resourceId: legacyClaim.resourceId, generation: legacyClaim.generation } } },
            { $set: { "legacyClaims.$.recovered": false } });
            await alerts.updateOne({ _id: key }, { $setOnInsert: { owner: legacyClaim.owner, resourceKind: kind,
              resourceId: row._id, generation: legacyClaim.generation, attemptId: randomUUID(),
              claimedAt: row.accessAlertClaimedAt, state: "legacy",
            }, $addToSet: { legacyClaims: { $each: claims } } }, { upsert: true });
            await alerts.updateOne({ _id: key, state: { $in: ["recovered", "pending"] } }, { $set: { state: "legacy" } });
          }
          if (++count % 100 === 0) await saveProgress();
        }
        await saveProgress();
      }
      if (heartbeatError) throw heartbeatError;
      const completed = await alerts.updateOne({ _id: MIGRATION, lease }, { $set: { state: "ready" }, $unset: { lease: "", leaseUntil: "" } });
      if (!completed.matchedCount) throw new Error("owner_alert_migration_lease_lost");
      await reconcileCompletedSends();
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
          $or: [{ ...claim, legacyClaims: { $exists: false } }, { legacyClaims: { $elemMatch: { ...claim, recovered: { $ne: true } } } }],
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
    let recovered = 0;
    for (const candidate of candidates) {
      const fence = { _id: candidate._id, attemptId: candidate.attemptId, resetRevision: generationFilter(candidate.resetRevision),
        state: { $in: ["pending", "accepted", "failed", "legacy"] } };
      if (candidate.legacyClaims) {
        const updated = await alertCollection().updateOne(fence, [{ $set: { legacyClaims: { $map: {
          input: "$legacyClaims", as: "claim", in: { $cond: [{ $and: [
            { $eq: ["$$claim.owner", identity.owner] }, { $eq: ["$$claim.resourceKind", resource.kind] },
            { $eq: ["$$claim.resourceId", identity._id] }, { $ne: ["$$claim.generation", snapshot.accessAlertGeneration ?? null] },
          ] }, { $mergeObjects: ["$$claim", { recovered: true }] }, "$$claim"] },
        } } } }, { $set: { state: { $cond: [{ $allElementsTrue: [{ $map: {
          input: "$legacyClaims", as: "claim", in: { $eq: ["$$claim.recovered", true] },
        } }] }, "recovered", "$state"] } } }]);
        recovered += updated.modifiedCount;
      } else {
        const removed = await alertCollection().deleteOne(fence);
        recovered += removed.deletedCount;
      }
    }
    if (recovered) logger.info("owner access email recovery confirmed", { recovered });
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
      let previous = await alerts.findOne({ _id: key });
      if (previous?.state === "sending") {
        await reconcileCompletedSend(previous);
        previous = await alerts.findOne({ _id: key });
      }
      if (!previous || previous.state === "sending" || !previous.owner || !previous.resourceId
        || !previous.resourceKind || !(previous.resourceKind in resourceCollections)) return;
      let retirement: mongo.Filter<AlertRecord> = { _id: key, attemptId: previous.attemptId, state: previous.state,
        resetRevision: generationFilter(previous.resetRevision) };
      if (previous.state === "pending") {
        if (!previous.claimedAt || previous.claimedAt.getTime() > Date.now() - PENDING_LEASE_MS) return;
        retirement = { ...retirement, ...expiredPending() };
      } else {
        const claims = previous.legacyClaims?.filter(claim => !claim.recovered) ?? [previous as LegacyClaim];
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
    const completedAt = new Date();
    try {
      await retryAlertWrite(async () => {
        try { await alertCollection("owner_access_alert_events").insertOne({ _id: `${attemptId}/completion`, attemptId,
          recipientKey: key, state, httpStatus, completedAt }); }
        catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
      });
    } catch { logger.warn("owner access email audit unavailable", { attemptId }); }
    try {
      await retryAlertWrite(() => alerts.updateOne({ _id: key, attemptId, state: "sending" }, { $set: { state, completedAt, httpStatus } }));
    } catch { logger.warn("owner access email result reconciliation required", { attemptId }); }
  } catch {
    logger.warn("owner access email unavailable");
  } finally {
    if (unsent && !providerStarted) {
      await alertCollection().deleteOne({ _id: unsent.key, attemptId: unsent.attemptId,
        state: { $in: ["pending", "sending"] } }).catch(() => logger.warn("owner access email claim cleanup unavailable"));
    }
  }
}
