import { REPOSITORY_ID_COLLATION } from "../repository-id";
import { randomUUID } from "crypto";
import ConferenceModel from "../model/conference/conferences.model";
import config from "../../config";
import { BillingGrant, BillingQuota } from "./models";
import { billingError, billingPlans } from "./config";
import RepositoryModel from "../model/anonymizedRepositories/anonymizedRepositories.model";

export function usableGrant(grant: { status?: string | null; until?: Date | null; revoked?: boolean | null }, now = new Date()) {
  return !grant.revoked && !!grant.until && grant.until > now && ["active", "paid", "past_due"].includes(grant.status || "");
}
export async function allowance(owner: string, repoId?: string, conference?: string) {
  const scopes = [`user:${owner}`, ...(repoId ? [`repo:${repoId}`] : []), ...(conference ? [`conference:${conference}`] : [])];
  const grants = await BillingGrant.find({ scope: { $in: scopes }, until: { $gt: new Date() }, revoked: false }).lean();
  // A conference pays before the author. There is no double charging of allowance.
  for (const scope of scopes.reverse()) {
    const grant = grants.find(g => g.scope === scope && usableGrant(g));
    const plan = grant && billingPlans().find(p => p.id === grant.planId);
    if (plan) return { scope, repositories: plan.repositories, storage: plan.storage, plan: plan.id };
  }
  return { scope: `user:${owner}`, repositories: config.FREE_AUTHOR_REPOSITORIES, storage: config.FREE_AUTHOR_STORAGE, plan: "free" };
}
export function allocationExpression(repoId: string) {
  return { $filter: { input: "$allocations", as: "allocation", cond: { $ne: ["$$allocation.repoId", { $literal: repoId }] } } };
}
export async function reserveRepository(owner: string, repoId: string, bytes: number, conference?: string, expansion?: { key: string; bytes: number }) {
  if (!config.BILLING_ENABLED) return;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw billingError("billing_invalid_repository_size");
  const limits = await allowance(owner, repoId, conference);
  // Seed existing repositories once. Legacy review links are preserved, but they
  // count toward the owner's capacity when creating new work.
  if (!await BillingQuota.exists({ _id: limits.scope })) {
    const existing = await RepositoryModel.find(limits.scope.startsWith("user:") ? { owner, status: { $nin: ["removed", "expired"] } }
      : limits.scope.startsWith("conference:") ? { conference, status: { $nin: ["removed", "expired"] } } : { repoId, status: { $nin: ["removed", "expired"] } }, null,
      limits.scope.startsWith("repo:") ? { collation: REPOSITORY_ID_COLLATION } : {})
      .select("repoId size owner conference").lean();
    const funded = [];
    for (const repository of existing) {
      if ((await allowance(String(repository.owner), repository.repoId, repository.conference)).scope === limits.scope) funded.push(repository);
    }
    try { await BillingQuota.create({ _id: limits.scope, allocations: funded.map(r => ({ repoId: r.repoId, reservationId: randomUUID(), bytes: r.size?.storage || 0, createdAt: new Date() })) }); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
  }
  // Only confirmed terminal repositories release capacity. Unknown reservations
  // remain until reconciled by an operator, so a crash cannot oversell capacity.
  const ledger = await BillingQuota.findById(limits.scope).lean();
  const terminal = await RepositoryModel.find({ repoId: { $in: ledger?.allocations.map(a => a.repoId) || [] }, status: "removed" }, null, { collation: REPOSITORY_ID_COLLATION }).select("repoId").lean();
  if (terminal.length) await BillingQuota.updateOne({ _id: limits.scope }, { $pull: { allocations: { $or: terminal.map(r => ({
    repoId: r.repoId, reservationId: ledger?.allocations.find(a => a.repoId === r.repoId)?.reservationId || { $exists: false },
  })) } } });
  const others = allocationExpression(repoId);
  // Never shrink a reservation during refresh. Concurrent generations and
  // failed builds cannot free bytes still needed by the published generation.
  const previous = { $arrayElemAt: [{ $filter: { input: "$allocations", as: "a", cond: { $eq: ["$$a.repoId", { $literal: repoId }] } } }, 0] };
  const oldExpansions = { $ifNull: [{ $getField: { field: "expansions", input: previous } }, []] };
  const sumExpansions = (input: object) => ({ $sum: { $map: { input, as: "e", in: "$$e.bytes" } } });
  const expansions = expansion ? { $concatArrays: [
    { $filter: { input: oldExpansions, as: "e", cond: { $ne: ["$$e.key", { $literal: expansion.key }] } } },
    [{ key: { $literal: expansion.key }, bytes: { $max: [expansion.bytes, { $sum: { $map: {
      input: { $filter: { input: oldExpansions, as: "e", cond: { $eq: ["$$e.key", { $literal: expansion.key }] } } }, as: "e", in: "$$e.bytes",
    } } }] } }],
  ] } : oldExpansions;
  const baseBytes = { $max: [bytes, { $ifNull: [{ $getField: { field: "baseBytes", input: previous } },
    { $subtract: [{ $ifNull: [{ $getField: { field: "bytes", input: previous } }, 0] }, sumExpansions(oldExpansions)] }] }] };
  const reservedBytes = { $add: [baseBytes, sumExpansions(expansions)] };
  const result = await BillingQuota.updateOne({ _id: limits.scope, $expr: { $and: [
    { $lt: [{ $size: others }, limits.repositories] },
    { $lte: [{ $add: [{ $sum: { $map: { input: others, as: "a", in: "$$a.bytes" } } }, reservedBytes] }, limits.storage] },
  ] } }, [{ $set: { allocations: { $concatArrays: [others, [{ repoId: { $literal: repoId }, reservationId: randomUUID(), bytes: reservedBytes, baseBytes, expansions, createdAt: new Date() }]] } } }]);
  if (!result.matchedCount) throw billingError("quota_exceeded", 402);
}

export async function assertConferenceAdmission(owner: string, repoId: string, conference?: string) {
  if (!conference || !config.BILLING_ENABLED) return;
  const conf = await ConferenceModel.findOne({ conferenceID: conference }).lean();
  if (!conf || conf.status !== "ready" || conf.startDate > new Date() || conf.endDate <= new Date()) throw billingError("conf_not_activated");
  if (conf.plan.planID === "conference" && (await allowance(owner, repoId, conference)).scope !== `conference:${conference}`) throw billingError("conference_payment_required", 402);
}

// Source trees report LFS pointer sizes. Charge resolved bytes before allowing
// them into the cache. Per-path high-water marks make retries/concurrent fills
// idempotent and conservatively retain capacity across generations.
export async function reserveFileExpansion(repoId: string, key: string, extraBytes: number) {
  if (!config.BILLING_ENABLED) return;
  if (!Number.isSafeInteger(extraBytes) || extraBytes < 0) throw billingError("billing_invalid_repository_size");
  const repo = await RepositoryModel.findOne({ repoId }, null, { collation: REPOSITORY_ID_COLLATION }).select("owner conference billingManaged").lean();
  if (!repo?.billingManaged) return;
  await reserveRepository(String(repo.owner), repoId, 0, repo.conference, { key, bytes: extraBytes });
}
