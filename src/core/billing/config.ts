import config from "../../config";
import AnonymousError from "../AnonymousError";

export type PlanId = "author_monthly" | "author_annual" | "author_pass" | "repo_extend" | "repo_never" | "repo_slot" | "repo_pack" | "conference_workshop" | "conference" | "conference_large";
// Repository add-ons bought once for a single repository.
export const REPOSITORY_ADDONS: PlanId[] = ["author_pass", "repo_extend", "repo_never", "repo_slot", "repo_pack"];
// A paper pack bundles what one paper needs during review into one checkout.
export const PACK_PLANS: PlanId[] = ["repo_slot", "author_pass", "repo_extend"];
// Capacity plans that do not include automatic updates.
export const MANUAL_REFRESH_PLANS = ["free", "repo_slot"];
// Conference review packages, smallest first. "conference" keeps its historical
// id for the middle tier so existing grants and conferences stay valid.
export const CONFERENCE_PLANS: PlanId[] = ["conference_workshop", "conference", "conference_large"];
export function isConferencePlan(id?: string | null) { return !!id && (CONFERENCE_PLANS as string[]).includes(id); }
export const REPO_EXTEND_MS = 365 * 86400_000;
export const REPO_NEVER_UNTIL = new Date("9999-12-31T00:00:00Z");
export const GiB = 1024 ** 3;
// Plans with `capacity` provide a storage allowance. The others only change expiration.
export function billingPlans() {
  return [
    { id: "author_monthly" as PlanId, name: "Author monthly", priceId: config.STRIPE_AUTHOR_MONTHLY_PRICE, recurring: true, capacity: true, repositories: config.PAID_AUTHOR_REPOSITORIES, storage: config.PAID_AUTHOR_STORAGE, description: "Never-expiring repositories while subscribed, then a 90-day grace period. Renews monthly. Cancel renewal at any time." },
    { id: "author_annual" as PlanId, name: "Author annual", priceId: config.STRIPE_AUTHOR_ANNUAL_PRICE, recurring: true, capacity: true, repositories: config.PAID_AUTHOR_REPOSITORIES, storage: config.PAID_AUTHOR_STORAGE, description: "Never-expiring repositories while subscribed, then a 90-day grace period. Renews annually. Cancel renewal at any time." },
    { id: "author_pass" as PlanId, name: "Live updates", priceId: config.STRIPE_AUTHOR_PASS_PRICE, recurring: false, capacity: true, repositories: 1, storage: config.PAID_PASS_STORAGE, description: "Automatic updates for one repository for 180 days, with its own storage allowance. No automatic renewal." },
    { id: "repo_extend" as PlanId, name: "Extended expiration", priceId: config.STRIPE_REPO_EXTEND_PRICE, recurring: false, capacity: false, repositories: 0, storage: 0, description: "Keep one repository online for up to one more year. Buy again to add another year. No automatic renewal." },
    { id: "repo_never" as PlanId, name: "Never expire", priceId: config.STRIPE_REPO_NEVER_PRICE, recurring: false, capacity: false, repositories: 0, storage: 0, description: "One repository never expires. One-time payment, no subscription." },
    { id: "repo_slot" as PlanId, name: "Extra repository", priceId: config.STRIPE_REPO_SLOT_PRICE, recurring: false, capacity: true, repositories: 1, storage: config.PAID_PASS_STORAGE, description: "Host one more repository beyond the free allowance, with its own storage. It does not count toward your free repositories. One-time payment, valid while the repository exists." },
    { id: "repo_pack" as PlanId, name: "Paper pack", priceId: config.STRIPE_REPO_PACK_PRICE, recurring: false, capacity: false, repositories: 0, storage: 0, description: "Everything one paper needs during review: an extra repository, automatic updates for 180 days, and one more year before it expires. One-time payment." },
    { id: "conference_workshop" as PlanId, name: "Workshop", priceId: config.STRIPE_CONFERENCE_SMALL_PRICE, recurring: false, capacity: true, repositories: config.PAID_CONFERENCE_SMALL_REPOSITORIES, storage: config.PAID_CONFERENCE_SMALL_STORAGE, description: "For a workshop or small venue. A review window of up to 180 days. No automatic renewal." },
    { id: "conference" as PlanId, name: "Conference", priceId: config.STRIPE_CONFERENCE_PRICE, recurring: false, capacity: true, repositories: config.PAID_CONFERENCE_REPOSITORIES, storage: config.PAID_CONFERENCE_STORAGE, description: "For a typical conference track. A review window of up to 180 days. No automatic renewal." },
    { id: "conference_large" as PlanId, name: "Large conference", priceId: config.STRIPE_CONFERENCE_LARGE_PRICE, recurring: false, capacity: true, repositories: config.PAID_CONFERENCE_LARGE_REPOSITORIES, storage: config.PAID_CONFERENCE_LARGE_STORAGE, description: "For a large venue with several tracks. A review window of up to 180 days. No automatic renewal." },
  ];
}
// Retired Stripe prices keep their plan, so existing subscriptions and
// purchases stay recognized after a price ID is replaced.
export function legacyPricePlans() {
  const plans = new Map<string, PlanId>();
  const ids = new Set(billingPlans().map(p => p.id as string));
  for (const entry of config.STRIPE_LEGACY_PRICES.split(",").map(e => e.trim()).filter(Boolean)) {
    const [price, plan] = entry.split(":").map(part => part.trim());
    if (!price || !plan || !ids.has(plan)) throw new Error(`Invalid STRIPE_LEGACY_PRICES entry: ${entry}`);
    plans.set(price, plan as PlanId);
  }
  return plans;
}
export function billingError(code: string, status = 400) { return new AnonymousError(code, { httpStatus: status }); }
export function billingOrigin() {
  const url = new URL(config.BILLING_ORIGIN);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("Invalid BILLING_ORIGIN");
  return url.origin;
}
export function requireBilling() {
  if (!config.BILLING_ENABLED || !config.STRIPE_SECRET_KEY || !config.STRIPE_WEBHOOK_SECRET) throw billingError("billing_unavailable", 503);
  billingOrigin();
}
