import { reconcileBillingAccount } from "./reconciliation";
import { createLogger } from "../logger";
import config from "../../config";
import { BillingGrant } from "./models";
import { billingError } from "./config";
import { usableGrant } from "./quotas";
import Repo from "../model/anonymizedRepositories/anonymizedRepositories.model";

export const NEVER_EXPIRATION_GRACE_MS = 90 * 86400000;
async function authorGrants(owner: string) {
  return BillingGrant.find({ scope: `user:${owner}`, planId: { $in: ["author_monthly", "author_annual"] } }).lean();
}

// This is an author benefit, independent of which scope pays the storage quota.
export async function neverExpirationDeadline(owner: string, existing?: Date) {
  if (!config.BILLING_ENABLED) return undefined;
  const grants = await authorGrants(owner);
  const active = grants.filter(g => usableGrant(g));
  if (!active.length) {
    if (existing && existing > new Date()) return existing;
    throw billingError("subscription_required_for_never_expiration", 402);
  }
  return new Date(Math.max(existing?.getTime() || 0, ...active.map(g => g.until!.getTime() + NEVER_EXPIRATION_GRACE_MS)));
}

// Run before ordinary expiration maintenance. Legacy never-expiring links have
// no billing deadline and are deliberately excluded.
export async function reconcileNeverExpiration(now = new Date(), reconcile = reconcileBillingAccount) {
  if (!config.BILLING_ENABLED) return;
  const cursor = Repo.find({ "options.expirationMode": "never", billingNeverExpiresUntil: { $exists: true },
    status: { $nin: ["removed", "expired", "expiring", "removing"] } }).select("owner billingNeverExpiresUntil").cursor();
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
    let deadline = new Date(Math.max(previous.getTime(), deadlines.get(owner)!));
    if (deadline <= now) {
      if (deferred.has(owner)) continue;
      try {
        if (!verified.has(owner)) {
          await reconcile(owner);
          verified.add(owner);
          const fresh = await authorGrants(owner);
          deadlines.set(owner, Math.max(0, ...fresh.filter(g => !g.revoked && g.until).map(g => g.until!.getTime() + NEVER_EXPIRATION_GRACE_MS)));
        }
        deadline = new Date(Math.max(previous.getTime(), deadlines.get(owner)!));
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

export function validateBillingExpiration(options: { expirationMode?: string; expirationDate?: string | Date }) {
  if (!config.BILLING_ENABLED || options.expirationMode === "never") return;
  const date = options.expirationDate && new Date(options.expirationDate);
  const maximum = new Date();
  maximum.setFullYear(maximum.getFullYear() + 1);
  maximum.setHours(23, 59, 59, 999);
  if (!["remove", "redirect"].includes(options.expirationMode || "") || !date ||
      !Number.isFinite(date.getTime()) || date > maximum) throw billingError("invalid_billing_expiration");
}
