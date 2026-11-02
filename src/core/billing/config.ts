import config from "../../config";
import AnonymousError from "../AnonymousError";

export type PlanId = "author_monthly" | "author_annual" | "author_pass" | "conference";
export const GiB = 1024 ** 3;
export function billingPlans() {
  return [
    { id: "author_monthly" as PlanId, name: "Author monthly", priceId: config.STRIPE_AUTHOR_MONTHLY_PRICE, recurring: true, repositories: config.PAID_AUTHOR_REPOSITORIES, storage: config.PAID_AUTHOR_STORAGE, description: "Never-expiring repositories while subscribed, then a 90-day grace period. Renews monthly. Cancel renewal at any time." },
    { id: "author_annual" as PlanId, name: "Author annual", priceId: config.STRIPE_AUTHOR_ANNUAL_PRICE, recurring: true, repositories: config.PAID_AUTHOR_REPOSITORIES, storage: config.PAID_AUTHOR_STORAGE, description: "Never-expiring repositories while subscribed, then a 90-day grace period. Renews annually. Cancel renewal at any time." },
    { id: "author_pass" as PlanId, name: "Author review pass", priceId: config.STRIPE_AUTHOR_PASS_PRICE, recurring: false, repositories: 1, storage: config.PAID_PASS_STORAGE, description: "One repository for 180 days. No automatic renewal." },
    { id: "conference" as PlanId, name: "Conference review package", priceId: config.STRIPE_CONFERENCE_PRICE, recurring: false, repositories: config.PAID_CONFERENCE_REPOSITORIES, storage: config.PAID_CONFERENCE_STORAGE, description: "A review window of up to 180 days. No automatic renewal." },
  ];
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
