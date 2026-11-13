import { reconcileBillingAccount } from "./reconciliation";
import { createLogger } from "../logger";
import config from "../../config";
import { BillingGrant } from "./models";
import { billingError, MANUAL_REFRESH_PLANS } from "./config";
import { allowance, usableGrant } from "./quotas";
import Repo from "../model/anonymizedRepositories/anonymizedRepositories.model";
import ConferenceModel from "../model/conference/conferences.model";

export const NEVER_EXPIRATION_GRACE_MS = 90 * 86400000;
// A one-time Never expire add-on keeps a rolling deadline this far ahead, so a
// refund or dispute still ends it after the usual grace period.
const ROLLING_REFRESH_MS = 7 * 86400000;
async function authorGrants(owner: string) {
  return BillingGrant.find({ scope: `user:${owner}`, planId: { $in: ["author_monthly", "author_annual"] } }).lean();
}
async function hasRepositoryGrant(owner: string, repoId: string, planId: string, now = new Date()) {
  const grants = await BillingGrant.find({ scope: `repo:${repoId}`, owner, planId, revoked: false, until: { $gt: now } }).lean();
  return grants.filter(g => usableGrant(g, now));
}

// Automatic updates come from the plan that funds the repository, or from the
// owner's author subscription even when a paid slot funds its storage.
export async function hasAutomaticUpdates(owner: string, repoId: string, conference?: string, now = new Date()) {
  if (!MANUAL_REFRESH_PLANS.includes((await allowance(owner, repoId, conference)).plan)) return true;
  return (await authorGrants(owner)).some(g => usableGrant(g, now));
}

// This is an author benefit, independent of which scope pays the storage quota.
// A repository's own Never expire add-on also qualifies.
export async function neverExpirationDeadline(owner: string, existing?: Date, repoId?: string) {
  if (!config.BILLING_ENABLED) return undefined;
  const now = new Date();
  const grants = await authorGrants(owner);
  const active = grants.filter(g => usableGrant(g, now));
  const addon = repoId ? (await hasRepositoryGrant(owner, repoId, "repo_never", now)).length > 0 : false;
  if (!active.length && !addon) {
    if (existing && existing > now) return existing;
    throw billingError("subscription_required_for_never_expiration", 402);
  }
  return new Date(Math.max(existing?.getTime() || 0, ...active.map(g => g.until!.getTime() + NEVER_EXPIRATION_GRACE_MS),
    addon ? now.getTime() + NEVER_EXPIRATION_GRACE_MS : 0));
}

function addMonths(date: Date, months: number) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  result.setHours(23, 59, 59, 999);
  return result;
}
// Free repositories can be scheduled FREE_EXPIRATION_MONTHS ahead. Author
// subscribers keep one year; an Extended expiration add-on sets its own limit.
export function freeExpirationLimit(now = new Date()) { return addMonths(now, config.FREE_EXPIRATION_MONTHS); }
export async function maximumExpiration(owner: string, repoId?: string, conference?: string, now = new Date()) {
  if (!config.BILLING_ENABLED) return addMonths(now, 12);
  let maximum = freeExpirationLimit(now).getTime();
  // Conference submissions can stay online until the end of the review window.
  const conf = conference && await ConferenceModel.findOne({ conferenceID: conference }).select("endDate").lean();
  if (conf && conf.endDate) maximum = Math.max(maximum, new Date(conf.endDate).getTime());
  if ((await authorGrants(owner)).some(g => usableGrant(g, now))) maximum = Math.max(maximum, addMonths(now, 12).getTime());
  if (repoId) {
    for (const grant of await hasRepositoryGrant(owner, repoId, "repo_extend", now)) {
      const limit = new Date(grant.until!);
      limit.setHours(23, 59, 59, 999);
      maximum = Math.max(maximum, limit.getTime());
    }
  }
  return new Date(maximum);
}

// Run before ordinary expiration maintenance. Legacy never-expiring links have
// no billing deadline and are deliberately excluded.
export async function reconcileNeverExpiration(now = new Date(), reconcile = reconcileBillingAccount) {
  if (!config.BILLING_ENABLED) return;
  const addons = new Set((await BillingGrant.find({ planId: "repo_never", revoked: false, until: { $gt: now } }).select("owner scope status until revoked").lean())
    .filter(g => usableGrant(g, now)).map(g => `${g.owner} ${g.scope}`));
  const cursor = Repo.find({ "options.expirationMode": "never", billingNeverExpiresUntil: { $exists: true },
    status: { $nin: ["removed", "expired", "expiring", "removing"] } }).select("owner repoId billingNeverExpiresUntil").cursor();
  const deadlines = new Map<string, number>();
  const verified = new Set<string>();
  const deferred = new Set<string>();
  for await (const repo of cursor) {
    const owner = String(repo.owner);
    if (!deadlines.has(owner)) {
      const grants = await authorGrants(owner);
      deadlines.set(owner, Math.max(0, ...grants.filter(g => !g.revoked && g.until)
        .map(g => g.until!.getTime() + NEVER_EXPIRATION_GRACE_MS)));
    }
    const previous = repo.billingNeverExpiresUntil!;
    // Roll the add-on deadline forward weekly rather than on every run.
    let rolling = addons.has(`${owner} repo:${repo.repoId}`) && previous.getTime() < now.getTime() + NEVER_EXPIRATION_GRACE_MS - ROLLING_REFRESH_MS
      ? now.getTime() + NEVER_EXPIRATION_GRACE_MS : 0;
    let deadline = new Date(Math.max(previous.getTime(), deadlines.get(owner)!, rolling));
    if (deadline <= now) {
      if (deferred.has(owner)) continue;
      try {
        if (!verified.has(owner)) {
          await reconcile(owner);
          verified.add(owner);
          const fresh = await authorGrants(owner);
          deadlines.set(owner, Math.max(0, ...fresh.filter(g => !g.revoked && g.until).map(g => g.until!.getTime() + NEVER_EXPIRATION_GRACE_MS)));
          // Reconciliation can recover a missed Never expire purchase too.
          for (const grant of await BillingGrant.find({ owner, planId: "repo_never", revoked: false, until: { $gt: now } }).select("owner scope status until revoked").lean()) {
            if (usableGrant(grant, now)) addons.add(`${grant.owner} ${grant.scope}`);
          }
        }
        if (addons.has(`${owner} repo:${repo.repoId}`)) rolling = now.getTime() + NEVER_EXPIRATION_GRACE_MS;
        deadline = new Date(Math.max(previous.getTime(), deadlines.get(owner)!, rolling));
      } catch {
        deferred.add(owner);
        createLogger("billing").error("repository expiration deferred: billing verification failed", { owner });
        continue;
      }
    }
    const filter = { _id: repo._id, "options.expirationMode": "never", billingNeverExpiresUntil: previous };
    if (deadline <= now) {
      await Repo.updateOne(filter, { $set: { "options.expirationMode": "remove", "options.expirationDate": deadline },
        $unset: { billingNeverExpiresUntil: 1 } });
    } else if (deadline > previous) {
      await Repo.updateOne(filter, { $set: { billingNeverExpiresUntil: deadline } });
    }
  }
}

// `current` keeps an already saved date valid, so lowering the limit does not
// block unrelated edits to existing repositories.
export function validateBillingExpiration(options: { expirationMode?: string; expirationDate?: string | Date },
  maximum = freeExpirationLimit(), current?: string | Date | null) {
  if (!config.BILLING_ENABLED || options.expirationMode === "never") return;
  const date = options.expirationDate && new Date(options.expirationDate);
  const unchanged = !!date && !!current && date.getTime() === new Date(current).getTime();
  if (!["remove", "redirect"].includes(options.expirationMode || "") || !date ||
      !Number.isFinite(date.getTime()) || (date > maximum && !unchanged)) throw billingError("invalid_billing_expiration");
}
