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
    const users = UserModel.db.collection("users");
    const owner = new Types.ObjectId(ownerId);
    const reset = await users.findOneAndUpdate({ _id: owner }, { $inc: { accessAlertResetRevision: 1 },
      $set: { accessAlertResetUntil: new Date(Date.now() + 60000) } }, { returnDocument: "after" });
    if (!reset.value) return;
    const revision = reset.value.accessAlertResetRevision;
    const heartbeat = setInterval(() => {
      void users.updateOne({ _id: owner, accessAlertResetRevision: revision, accessAlertResetUntil: { $exists: true } },
        { $set: { accessAlertResetUntil: new Date(Date.now() + 60000) } }).catch(() => {});
    }, 10000);
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
        await UserModel.db.collection(collection).updateMany(filter, { $unset: { accessAlertClaimedAt: "", accessAlertAttemptId: "" }, $set: { accessAlertGeneration: randomUUID() } });
      }
    } finally {
      clearInterval(heartbeat);
      const finished = await users.updateOne({ _id: owner, accessAlertResetRevision: revision }, { $unset: { accessAlertResetUntil: "" } });
      if (finished.matchedCount) {
        for await (const candidate of alertCollection().find({ deferredRecoveries: { $elemMatch: { owner } } })) {
          await applyDeferredRecoveries(candidate._id, candidate.attemptId);
        }
      }
    }
  } catch { logger.warn("owner access alert reset unavailable"); }
}
export const RECIPIENT_ALERTS = "owner_access_alert_recipients";
type LegacyClaim = { owner: Types.ObjectId; resourceKind: AlertResource["kind"]; resourceId: Types.ObjectId; generation: string | null; recovered?: boolean };
type DeferredRecovery = { owner: Types.ObjectId; resourceKind: AlertResource["kind"]; resourceId: Types.ObjectId;
  generation: string | null; resetRevision: number | null; ownerRevision: number | null; bindingFields: string[]; bindingHash: string };
type AlertRecord = { _id: string; state?: string; lease?: string; leaseUntil?: Date;
  owner?: Types.ObjectId; resourceKind?: string; resourceId?: Types.ObjectId;
  generation?: string | null; attemptId?: string; claimedAt?: Date; completedAt?: Date;
  recipientKey?: string; resetRevision?: number; httpStatus?: number; startedAt?: Date;
  progress?: Record<string, { claimedAt: Date; id: Types.ObjectId }>; legacyClaims?: LegacyClaim[];
  resourceRevision?: number; deferredRecoveries?: DeferredRecovery[]; dispatchPrepared?: boolean;
  deliveryProgress?: { completedAt: Date; id: string }; failureCode?: string };
const alertCollection = (name = RECIPIENT_ALERTS) => UserModel.db.collection(name) as unknown as mongo.Collection<AlertRecord>;
const MIGRATION = "recipient-alerts-v2";
const PENDING_LEASE_MS = 60000;
const expiredPending = () => ({ state: "pending", claimedAt: { $lte: new Date(Date.now() - PENDING_LEASE_MS) } });
const expiredPreparation = () => ({ state: { $in: ["pending", "sending"] }, claimedAt: { $lte: new Date(Date.now() - PENDING_LEASE_MS) } });
const revisionFilter = (revision: number) => revision === 0 ? { $in: [0, null] } : revision;
const generationFilter = (generation: unknown) => generation ?? { $exists: false };
export const recipientAlertKey = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
const bindingHash = (row: Record<string, unknown>, fields: string[]) => createHash("sha256").update(JSON.stringify(fields.map(field => {
  const value = field.split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, row);
  return [field, value !== undefined, value];
}))).digest("hex");

async function prepareOwnerDispatch(record: AlertRecord, revision: number | null): Promise<boolean> {
  const path = `accessAlertDispatches.${record.attemptId}`;
  const prepared = await UserModel.db.collection("users").updateOne({ _id: record.owner,
    accessAlertResetRevision: generationFilter(revision),
    "accessAlertDeactivations.0": { $exists: false },
    $or: [{ accessAlertResetUntil: { $exists: false } }, { accessAlertResetUntil: { $lte: new Date() } }],
  }, [{ $set: { accessAlertDispatches: { $arrayToObject: { $filter: {
    input: { $objectToArray: { $ifNull: ["$accessAlertDispatches", {}] } }, as: "dispatch",
    cond: { $or: [{ $eq: ["$$dispatch.v.state", "committed"] },
      { $gt: ["$$dispatch.v.claimedAt", new Date(Date.now() - PENDING_LEASE_MS)] }] },
  } } } } }, { $set: { [path]: { state: "prepared", claimedAt: record.claimedAt } } }]);
  return Boolean(prepared.matchedCount);
}

async function clearOwnerDispatch(record: AlertRecord, state: string): Promise<void> {
  if (!record.dispatchPrepared || !record.owner || !record.attemptId) return;
  const path = `accessAlertDispatches.${record.attemptId}`;
  await UserModel.db.collection("users").updateOne({ _id: record.owner, [`${path}.state`]: state }, { $unset: { [path]: "" } });
}

async function commitOwnerRevision(owner: Types.ObjectId, revision: number | null | undefined, record?: AlertRecord): Promise<boolean> {
  const path = `accessAlertDispatches.${record?.attemptId}`;
  const committed = await UserModel.db.collection("users").updateOne({ _id: owner,
    accessAlertResetRevision: generationFilter(revision),
    "accessAlertDeactivations.0": { $exists: false },
    ...(record ? { [`${path}.state`]: "prepared" } : {}),
    $or: [{ accessAlertResetUntil: { $exists: false } }, { accessAlertResetUntil: { $lte: new Date() } }],
  }, record ? { $set: { [`${path}.state`]: "committed" } } : { $inc: { accessAlertFenceRevision: 1 } });
  return Boolean(committed.matchedCount);
}

async function releaseUnsentAlert(record: AlertRecord, expected: mongo.Filter<AlertRecord>): Promise<boolean> {
  if (!record.attemptId) return false;
  const alerts = alertCollection();
  if (record.dispatchPrepared && record.owner) {
    const users = UserModel.db.collection("users");
    const path = `accessAlertDispatches.${record.attemptId}`;
    // This CAS competes with the final dispatch commitment on the owner document.
    const cancelled = await users.updateOne({ _id: record.owner, [`${path}.state`]: "prepared" },
      { $set: { [`${path}.state`]: "cancelled" } });
    if (!cancelled.matchedCount) {
      const owner = await users.findOne({ _id: record.owner }, { projection: { [path]: 1 } });
      if (!owner || owner.accessAlertDispatches?.[record.attemptId]?.state === "committed") return false;
    }
  }
  // A durable cancellation prevents a paused sender from starting dispatch.
  const cancelled = await alerts.updateOne({ _id: record._id, attemptId: record.attemptId, ...expected }, { $set: { state: "cancelled" } });
  if (!cancelled.matchedCount) return false;
  if (record.owner && record.resourceKind && record.resourceKind in resourceCollections && record.resourceId) {
    const resource = UserModel.db.collection(resourceCollections[record.resourceKind as AlertResource["kind"]]);
    const revision = record.resourceRevision ?? 0;
    const matching = {
      _id: record.resourceId, owner: record.owner, accessAlertGeneration: generationFilter(record.generation),
      $or: [{ accessAlertClaimRevision: revisionFilter(revision) },
        { accessAlertClaimRevision: revision + 1, accessAlertAttemptId: record.attemptId }],
    };
    await retryAlertWrite(() => resource.updateOne(matching, [{ $set: {
      accessAlertClaimRevision: { $add: [{ $ifNull: ["$accessAlertClaimRevision", 0] }, 1] },
      accessAlertClaimedAt: { $cond: [{ $eq: ["$accessAlertAttemptId", record.attemptId] }, "$$REMOVE", "$accessAlertClaimedAt"] },
      accessAlertAttemptId: { $cond: [{ $eq: ["$accessAlertAttemptId", record.attemptId] }, "$$REMOVE", "$accessAlertAttemptId"] },
    } }]));
  }
  const removed = await alerts.deleteOne({ _id: record._id, attemptId: record.attemptId, state: "cancelled" });
  if (removed.deletedCount) await clearOwnerDispatch(record, "cancelled");
  return Boolean(removed.deletedCount);
}

async function reconcileUnsentAlerts(writersStopped = false): Promise<void> {
  const pending = writersStopped ? { state: "pending" } : expiredPending();
  const preparing = { ...(writersStopped ? { state: "sending" } : { ...expiredPreparation(), state: "sending" }), dispatchPrepared: true };
  for await (const record of alertCollection().find({ $or: [pending, preparing, { state: "cancelled" }] })) {
    await releaseUnsentAlert(record, record.state === "cancelled" ? { state: "cancelled" }
      : writersStopped ? { state: record.state } : expiredPreparation());
  }
}

/** Call only after all application writers have stopped. */
export async function prepareLegacyOwnerAlertMigration(): Promise<void> {
  await reconcileUnsentAlerts(true);
  // Interrupted lifecycle mutations cannot resume once every writer is stopped.
  await UserModel.db.collection("users").updateMany({ accessAlertDeactivations: { $exists: true } },
    { $unset: { accessAlertDeactivations: "" }, $inc: { accessAlertResetRevision: 1 } });
  await alertCollection().updateOne({ _id: MIGRATION }, { $set: { state: "new" },
    $unset: { progress: "", deliveryProgress: "", lease: "", leaseUntil: "" } }, { upsert: true });
}

async function reconcileCompletedSend(record: AlertRecord): Promise<void> {
  if (record.state !== "sending" || !record.attemptId) return;
  const completion = await alertCollection("owner_access_alert_events").findOne({ _id: `${record.attemptId}/completion` });
  if (!completion || !["accepted", "failed"].includes(completion.state || "")) return;
  await alertCollection().updateOne({ _id: record._id, attemptId: record.attemptId, state: "sending" },
    { $set: { state: completion.state, completedAt: completion.completedAt, httpStatus: completion.httpStatus } });
  await clearOwnerDispatch(record, "committed");
  await applyDeferredRecoveries(record._id, record.attemptId);
}

async function reconcileCompletedSends(): Promise<void> {
  for await (const record of alertCollection().find({ state: "sending" })) await reconcileCompletedSend(record);
  for await (const record of alertCollection().find({ state: { $in: ["accepted", "failed", "legacy"] },
    $or: [{ deferredRecoveries: { $exists: true } }, { dispatchPrepared: true }] })) {
    await clearOwnerDispatch(record, "committed");
    await applyDeferredRecoveries(record._id, record.attemptId);
  }
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
  await alerts.createIndex({ "deferredRecoveries.owner": 1 });
  // Clear known-unsent legacy fields before they can be mistaken for deliveries.
  await reconcileUnsentAlerts();
  try { await alerts.updateOne({ _id: MIGRATION }, { $setOnInsert: { state: "new" } }, { upsert: true }); }
  catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
  const lease = randomUUID();
  for (;;) {
    if ((await alerts.findOne({ _id: MIGRATION }))?.state === "ready") {
      await reconcileCompletedSends();
      await reconcileUnsentAlerts();
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
      // Delivery evidence survives v1 guard recovery and resource deletion. Restore
      // missing guards once, before traffic, so those addresses cannot be emailed again.
      const events = alertCollection("owner_access_alert_events");
      const index = "owner_access_alert_delivery_history";
      await events.createIndex({ completedAt: 1, _id: 1 }, { name: index,
        partialFilterExpression: { completedAt: { $exists: true } } });
      const checkpoint = (await alerts.findOne({ _id: MIGRATION, lease }))?.deliveryProgress;
      const filter = { state: { $in: ["accepted", "failed"] }, completedAt: { $exists: true },
        ...(checkpoint ? { $or: [{ completedAt: { $gt: checkpoint.completedAt } },
          { completedAt: checkpoint.completedAt, _id: { $gt: checkpoint.id } }] } : {}) };
      let lastDelivery: { completedAt: Date; id: string } | undefined;
      let delivered = 0;
      const saveDeliveries = async () => {
        if (!lastDelivery) return;
        const saved = await alerts.updateOne({ _id: MIGRATION, lease }, { $set: { deliveryProgress: lastDelivery } });
        if (!saved.matchedCount) throw new Error("owner_alert_migration_lease_lost");
      };
      for await (const event of events.find(filter).sort({ completedAt: 1, _id: 1 }).hint(index).batchSize(100)) {
        if (heartbeatError) throw heartbeatError;
        if (event.recipientKey && /^[0-9a-f]{64}$/.test(event.recipientKey)) {
          const previous = await alerts.findOne({ _id: event.recipientKey });
          if (previous && (["pending", "cancelled"].includes(previous.state || "")
            || (previous.state === "sending" && previous.dispatchPrepared))) {
            // A v1 repeat may still be preparing after its earlier guard was
            // released. Cancel known-unsent work even while its lease is fresh;
            // committed or ambiguous dispatches remain blocked instead.
            await releaseUnsentAlert(previous, { state: previous.state });
          }
          await alerts.updateOne({ _id: event.recipientKey }, { $setOnInsert: {
            state: "recipient_notified", attemptId: event.attemptId ?? randomUUID(),
            claimedAt: event.completedAt, completedAt: event.completedAt, httpStatus: event.httpStatus,
          } }, { upsert: true });
        }
        lastDelivery = { completedAt: event.completedAt!, id: event._id };
        if (++delivered % 100 === 0) await saveDeliveries();
      }
      await saveDeliveries();
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
      await reconcileUnsentAlerts();
      return;
    } finally { clearInterval(heartbeat); }
  }
}

async function completeRecovery(candidate: AlertRecord, recovery: DeferredRecovery): Promise<void> {
  if (candidate.state !== "pending") await clearOwnerDispatch(candidate, "committed");
  const fence = { _id: candidate._id, attemptId: candidate.attemptId, resetRevision: generationFilter(recovery.resetRevision),
    state: { $in: ["pending", "accepted", "failed", "legacy"] } };
  if (candidate.legacyClaims) {
    await alertCollection().updateOne(fence, [{ $set: { legacyClaims: { $map: {
      input: "$legacyClaims", as: "claim", in: { $cond: [{ $and: [
        { $eq: ["$$claim.owner", recovery.owner] }, { $eq: ["$$claim.resourceKind", recovery.resourceKind] },
        { $eq: ["$$claim.resourceId", recovery.resourceId] }, { $ne: ["$$claim.generation", recovery.generation] },
      ] }, { $mergeObjects: ["$$claim", { recovered: true }] }, "$$claim"] },
    } } } }, { $set: { state: { $cond: [{ $allElementsTrue: [{ $map: {
      input: "$legacyClaims", as: "claim", in: { $eq: ["$$claim.recovered", true] },
    } }] }, "recovered", "$state"] } } }]);
  } else if (candidate.state === "pending") {
    await releaseUnsentAlert(candidate, { ...fence, state: "pending" });
  } else {
    // Recovery does not authorize another generic email to the same address.
    await alertCollection().updateOne(fence, { $set: { state: "recovered" } });
  }
}

const delayedRecoveries = new Map<string, NodeJS.Timeout>();
function deferRecoveryUntil(key: string, attemptId: string | undefined, until: Date): void {
  const timerKey = `${key}/${attemptId}`;
  if (delayedRecoveries.has(timerKey)) return;
  const timer = setTimeout(() => {
    delayedRecoveries.delete(timerKey);
    void retryAlertWrite(() => applyDeferredRecoveries(key, attemptId))
      .catch(() => logger.warn("owner access email deferred recovery unavailable"));
  }, Math.max(1, until.getTime() - Date.now() + 1));
  timer.unref();
  delayedRecoveries.set(timerKey, timer);
}

async function applyDeferredRecoveries(key: string, attemptId?: string): Promise<void> {
  const timerKey = `${key}/${attemptId}`;
  clearTimeout(delayedRecoveries.get(timerKey));
  delayedRecoveries.delete(timerKey);
  const candidate = await alertCollection().findOne({ _id: key, attemptId });
  if (!candidate || !["pending", "accepted", "failed", "legacy"].includes(candidate.state || "")) return;
  for (const recovery of candidate.deferredRecoveries ?? []) {
    if (recovery.resetRevision !== (candidate.resetRevision ?? null)) continue;
    const row = await UserModel.db.collection(resourceCollections[recovery.resourceKind]).findOne({
      _id: recovery.resourceId, owner: recovery.owner, accessAlertGeneration: generationFilter(recovery.generation),
    });
    if (!row || bindingHash(row, recovery.bindingFields) !== recovery.bindingHash) continue;
    if (!await commitOwnerRevision(recovery.owner, recovery.ownerRevision)) {
      const owner = await UserModel.db.collection("users").findOne({ _id: recovery.owner,
        accessAlertResetRevision: generationFilter(recovery.ownerRevision) }, { projection: { accessAlertResetUntil: 1 } });
      if (!owner) continue;
      if (owner.accessAlertResetUntil?.getTime() > Date.now()) {
        deferRecoveryUntil(key, attemptId, owner.accessAlertResetUntil);
        continue;
      }
      // The lease may have cleared between the failed CAS and this read.
      if (!await commitOwnerRevision(recovery.owner, recovery.ownerRevision)) continue;
    }
    await completeRecovery(candidate, recovery);
  }
}

/** Confirm recovery after owner action; only known-unsent claims may be released. */
export async function withOwnerAccessRecovery<T>(ownerId: string, resource: AlertResource, work: () => Promise<T>, expectedSource: Record<string, unknown> = {}, confirmed: (result: T) => boolean = () => true): Promise<T> {
  let snapshot: { accessAlertGeneration?: string } | null = null;
  let candidates: AlertRecord[] = [];
  let ownerRevision: number | null = null;
  const valid = UserModel.db.readyState === 1 && Types.ObjectId.isValid(ownerId) && Types.ObjectId.isValid(resource.id);
  const identity = valid ? { _id: new Types.ObjectId(resource.id), owner: new Types.ObjectId(ownerId), ...expectedSource } : null;
  if (identity) {
    try {
      const row = await UserModel.db.collection(resourceCollections[resource.kind]).findOne(identity, { projection: { accessAlertGeneration: 1 } });
      snapshot = row ? { accessAlertGeneration: row.accessAlertGeneration } : null;
      if (snapshot) {
        const claim = { owner: identity.owner, resourceKind: resource.kind, resourceId: identity._id,
          generation: { $ne: snapshot.accessAlertGeneration ?? null } };
        candidates = await alertCollection().find({ state: { $in: ["pending", "accepted", "failed", "legacy", "sending"] },
          $or: [{ ...claim, legacyClaims: { $exists: false } }, { legacyClaims: { $elemMatch: { ...claim, recovered: { $ne: true } } } }],
        }).toArray();
        if (candidates.length) ownerRevision = (await UserModel.db.collection("users").findOne({ _id: identity.owner },
          { projection: { accessAlertResetRevision: 1 } }))?.accessAlertResetRevision ?? null;
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
    let recorded = 0;
    for (const candidate of candidates) {
      const fence = { _id: candidate._id, attemptId: candidate.attemptId, resetRevision: generationFilter(candidate.resetRevision),
        state: { $in: ["pending", "accepted", "failed", "legacy", "sending"] } };
      const fields = Object.keys(expectedSource);
      const recovery: DeferredRecovery = { owner: identity.owner, resourceKind: resource.kind, resourceId: identity._id,
        generation: snapshot.accessAlertGeneration ?? null, resetRevision: candidate.resetRevision ?? null, ownerRevision,
        bindingFields: fields, bindingHash: bindingHash(current, fields) };
      const saved = await alertCollection().updateOne(fence, [{ $set: { deferredRecoveries: { $concatArrays: [
        { $filter: { input: { $ifNull: ["$deferredRecoveries", []] }, as: "recovery", cond: { $not: [{ $and: [
          { $eq: ["$$recovery.owner", identity.owner] }, { $eq: ["$$recovery.resourceKind", resource.kind] },
          { $eq: ["$$recovery.resourceId", identity._id] },
        ] }] } } }, [recovery],
      ] } } }]);
      if (saved.matchedCount) recorded++;
      await applyDeferredRecoveries(candidate._id, candidate.attemptId);
    }
    if (recorded) logger.info("owner access email recovery recorded", { resources: recorded });
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
  let unsent: AlertRecord | undefined;
  let dispatchRecord: AlertRecord | undefined;
  let providerStarted = false;
  try {
    if (!resource || !Types.ObjectId.isValid(resource.id) || !Types.ObjectId.isValid(ownerId)) return;
    const collection = UserModel.db.collection(resourceCollections[resource.kind]);
    const identity = { _id: new Types.ObjectId(resource.id), owner: new Types.ObjectId(ownerId),
      status: { $nin: ["archived", "expired", "expiring", "removed", "removing"] } };
    const ownerState = await UserModel.db.collection("users").findOne({ _id: identity.owner },
      { projection: { accessAlertResetRevision: 1, accessAlertResetUntil: 1, accessAlertDeactivations: 1 } });
    if (!ownerState || ownerState.accessAlertDeactivations?.length || ownerState.accessAlertResetUntil?.getTime() > Date.now()) return;
    const ownerRevision = ownerState.accessAlertResetRevision ?? null;
    const snapshot = await collection.findOne(identity, { projection: { accessAlertGeneration: 1, accessAlertClaimedAt: 1, accessAlertClaimRevision: 1 } });
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
      resourceRevision: snapshot.accessAlertClaimRevision ?? 0, attemptId, claimedAt: new Date(), state: "pending", dispatchPrepared: true };
    dispatchRecord = record;
    if (!await prepareOwnerDispatch(record, ownerRevision)) return;
    unsent = record;
    try { await alerts.insertOne(record); }
    catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      unsent = undefined;
      let previous = await alerts.findOne({ _id: key });
      if (previous?.state === "sending") {
        await reconcileCompletedSend(previous);
        previous = await alerts.findOne({ _id: key });
      }
      if (previous && ["accepted", "failed"].includes(previous.state || "")) {
        await clearOwnerDispatch(previous, "committed");
        await applyDeferredRecoveries(previous._id, previous.attemptId);
        previous = await alerts.findOne({ _id: key });
      }
      if (previous?.state === "sending" && previous.dispatchPrepared && previous.claimedAt
        && previous.claimedAt.getTime() <= Date.now() - PENDING_LEASE_MS) {
        if (await releaseUnsentAlert(previous, expiredPreparation())) previous = await alerts.findOne({ _id: key });
      }
      if (previous && (previous.state === "sending" || !previous.owner || !previous.resourceId
        || !previous.resourceKind || !(previous.resourceKind in resourceCollections))) return;
      if (previous) {
        const retirement: mongo.Filter<AlertRecord> = { _id: key, attemptId: previous.attemptId, state: previous.state,
          resetRevision: generationFilter(previous.resetRevision) };
        let retired: boolean;
        if (previous.state === "pending" || previous.state === "cancelled") {
          if (previous.state === "pending") {
            if (!previous.claimedAt || previous.claimedAt.getTime() > Date.now() - PENDING_LEASE_MS) return;
          }
          retired = await releaseUnsentAlert(previous, previous.state === "cancelled" ? retirement : { ...retirement, ...expiredPending() });
        } else {
          // Delivered, legacy, recovered and ambiguous sends stay blocked permanently,
          // even if their original resource or account no longer exists.
          return;
        }
        if (!retired) return;
      }
      unsent = record;
      try { await alerts.insertOne(record); }
      catch (replacementError) { if ((replacementError as { code?: number }).code === 11000) { unsent = undefined; return; } throw replacementError; }
    }
    // An earlier claim may have been reclaimed after the initial snapshot, even
    // when insertOne succeeded. Persist the current fence before resource preparation.
    const current = await collection.findOne({ ...identity, accessAlertGeneration: generationFilter(record.generation) },
      { projection: { accessAlertClaimRevision: 1 } });
    if (!current) return;
    const revision = current.accessAlertClaimRevision ?? 0;
    const refreshed = await alerts.updateOne({ _id: key, attemptId, state: "pending",
      resetRevision: generationFilter(record.resetRevision) }, { $set: { resourceRevision: revision } });
    if (!refreshed.matchedCount) return;
    record.resourceRevision = revision;
    const base = /^https?:\/\//.test(config.APP_HOSTNAME) ? config.APP_HOSTNAME : `https://${config.APP_HOSTNAME}`;
    const url = new URL("/connections", base).href;
    await alertCollection("owner_access_alert_events").insertOne({ _id: attemptId, attemptId,
      recipientKey: key, state: "prepared", startedAt: new Date(), owner: identity.owner,
      resourceKind: resource.kind, resourceId: identity._id, generation: record.generation,
      failureCode: accessErrors.has(typeof error === "string" ? error : error instanceof Error ? error.message : "")
        ? typeof error === "string" ? error : (error as Error).message : "upstream_access_failure" });
    const claim = await collection.updateOne({ ...identity,
      accessAlertGeneration: generationFilter(record.generation),
      accessAlertClaimRevision: revisionFilter(record.resourceRevision ?? 0),
    }, { $set: { accessAlertClaimedAt: new Date(), accessAlertAttemptId: attemptId }, $inc: { accessAlertClaimRevision: 1 } });
    if (!claim.matchedCount || !await collection.findOne({ ...identity,
      accessAlertGeneration: generationFilter(record.generation),
      accessAlertClaimRevision: (record.resourceRevision ?? 0) + 1, accessAlertAttemptId: attemptId,
    })) return;
    // Reserve the recipient transition, but it remains reclaimable until the owner CAS commits dispatch.
    const dispatch = await alerts.updateOne({ _id: key, attemptId, state: "pending",
      resetRevision: generationFilter(record.resetRevision) }, { $set: { state: "sending" } });
    if (!dispatch.matchedCount) return;
    // Reset and dispatch commit on the same owner document. There is no asynchronous
    // preparation between this authoritative commitment and the provider request.
    if (!await commitOwnerRevision(identity.owner, ownerRevision, record)) return;
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
          recipientKey: key, state, httpStatus, completedAt, owner: identity.owner,
          resourceKind: resource.kind, resourceId: identity._id, generation: record.generation }); }
        catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
      });
    } catch { logger.warn("owner access email audit unavailable", { attemptId }); }
    try {
      await retryAlertWrite(async () => {
        await alerts.updateOne({ _id: key, attemptId, state: "sending" }, { $set: { state, completedAt, httpStatus } });
        await clearOwnerDispatch(record, "committed");
        await applyDeferredRecoveries(key, attemptId);
      });
    } catch { logger.warn("owner access email result reconciliation required", { attemptId }); }
  } catch {
    logger.warn("owner access email unavailable");
  } finally {
    if (unsent && !providerStarted) {
      await releaseUnsentAlert(unsent, { state: { $in: ["pending", "sending", "cancelled"] } })
        .catch(() => logger.warn("owner access email claim cleanup unavailable"));
    }
    if (dispatchRecord) await clearOwnerDispatch(dispatchRecord, "prepared")
      .catch(() => logger.warn("owner access email preparation cleanup unavailable"));
  }
}
