import { createHash } from "crypto";
import { InferSchemaType } from "mongoose";
import config from "../../config";
import UserModel from "../model/users/users.model";
import { BillingEvent, BillingGrant, BillingRevocation } from "./models";
import { billingHealth } from "./events";
import { stripeClient } from "./stripe";
import { billingPlans, CONFERENCE_PLANS, PACK_PLANS, PlanId, REPO_NEVER_UNTIL } from "./config";

// Admin billing report. A sale is one checkout or one subscription: the three
// grants of a paper pack count once, under "repo_pack". Grants hold no amounts,
// so revenue is the Stripe list price of each sale's price, resolved once per
// price and kept in memory (a Stripe price's amount never changes).

export const BILLING_PERIODS: Record<string, number | null> = { "7d": 7, "30d": 30, "90d": 90, "12m": 365, all: null };
export const SUBSCRIPTION_PLANS = ["author_monthly", "author_annual"];
export const USABLE_STATUSES = ["active", "paid", "past_due"];
export type Family = "subscription" | "repository" | "conference";
export type Money = Record<string, number>;
type Bucket = "day" | "week" | "month";

export function planFamily(planId?: string | null): Family {
  if (planId === "subscription_unknown" || SUBSCRIPTION_PLANS.includes(planId || "")) return "subscription";
  if ((CONFERENCE_PLANS as string[]).includes(planId || "")) return "conference";
  return "repository";
}
export function bucketFor(period: string): Bucket {
  return period === "12m" ? "week" : period === "all" ? "month" : "day";
}
// The UTC start of the bucket holding `date`, matching Mongo's $dateTrunc (weeks start on Monday).
export function truncate(date: Date, unit: Bucket) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), unit === "month" ? 1 : date.getUTCDate()));
  if (unit === "week") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}
function nextBucket(date: Date, unit: Bucket) {
  const d = new Date(date);
  if (unit === "month") d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCDate(d.getUTCDate() + (unit === "week" ? 7 : 1));
  return d;
}
// The start of a period: N days are N daily buckets ending with today, and
// 12 months are 52 weekly buckets ending with this week. The tiles, the chart
// and the list's period filter all count from this date.
export function periodStart(period: string, now = new Date()) {
  const days = BILLING_PERIODS[period];
  if (days == null) return null;
  const unit = bucketFor(period);
  const start = truncate(now, unit);
  start.setUTCDate(start.getUTCDate() - (unit === "week" ? 7 * (Math.floor(days / 7) - 1) : days - 1));
  return start;
}

type Price = { amount: number; currency: string; interval: string | null; intervalCount: number };
type PriceLookup = (id: string) => Promise<{ unit_amount: number | null; currency: string; recurring?: { interval: string; interval_count: number } | null }>;
const priceCache = new Map<string, Price>();
const priceFailures = new Map<string, number>();
export function clearPriceCache() { priceCache.clear(); priceFailures.clear(); }
export function revenueAvailable() { return config.BILLING_ENABLED && !!config.STRIPE_SECRET_KEY; }
// Resolves each distinct price once. A failed lookup is retried after a minute,
// and its sales are reported as missing rather than counted as zero.
export async function resolvePrices(ids: string[], lookup: PriceLookup = id => stripeClient().prices.retrieve(id)) {
  await Promise.all([...new Set(ids)].filter(id => id && !priceCache.has(id) && !((priceFailures.get(id) || 0) > Date.now())).map(async id => {
    try {
      const p = await lookup(id);
      if (p.unit_amount == null) throw new Error("price_without_amount");
      priceCache.set(id, { amount: p.unit_amount, currency: p.currency, interval: p.recurring?.interval || null, intervalCount: p.recurring?.interval_count || 1 });
      priceFailures.delete(id);
    } catch { priceFailures.set(id, Date.now() + 60_000); }
  }));
  return priceCache;
}
const add = (money: Money, currency: string, amount: number) => { money[currency] = (money[currency] || 0) + amount; };
const roundMoney = (money: Money) => Object.fromEntries(Object.entries(money).map(([c, v]) => [c, Math.round(v)]));
// The monthly value of one period of a recurring price.
export function monthlyAmount(price: Price, planId?: string | null) {
  const interval = price.interval || (planId === "author_annual" ? "year" : "month");
  const perMonth = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 }[interval] ?? 1;
  return price.amount * perMonth / (price.intervalCount || 1);
}

const PACK_PART = "^cs_[^:]+:(repo_slot|author_pass|repo_extend)$";
type Row = { _id: { plan: string; priceId?: string | null; reason?: string }; count: number; cancelling?: number };
type SeriesRow = { _id: { bucket: Date; plan: string; priceId?: string | null }; count: number };

// One document per sale, shared by the summary and the list so both count the
// same unit: a paper pack's three grants become one "repo_pack" sale.
function saleStages(now: Date) {
  const isPack = { $regexMatch: { input: { $toString: "$_id" }, regex: PACK_PART } };
  const subscription = { $ne: [{ $ifNull: ["$subscriptionId", null] }, null] };
  return [
    { $project: {
      sale: { $cond: [isPack, { $arrayElemAt: [{ $split: ["$_id", ":"] }, 0] }, "$_id"] },
      plan: { $cond: [isPack, "repo_pack", { $cond: [subscription, { $ifNull: ["$salePlanId", "subscription_unknown"] }, { $ifNull: ["$planId", "unknown"] }] }] },
      priceId: { $cond: [subscription, { $ifNull: ["$salePriceId", null] }, "$priceId"] },
      currentPriceId: "$priceId", currentPlan: { $cond: [isPack, "repo_pack", { $ifNull: ["$planId", "unknown"] }] },
      // syncSubscription only advances until from a paid invoice and retains it
      // after cancellation. Epoch means no payment has ever granted service.
      purchasedAt: { $cond: [
        { $and: [subscription, { $not: [{ $gt: ["$until", new Date(0)] }] }] },
        null, "$purchasedAt",
      ] },
      startedAt: "$purchasedAt", until: 1, owner: 1, scope: 1, status: 1, subscription,
      part: { $cond: [isPack, { planId: "$planId", until: "$until" }, "$$REMOVE"] },
      cancel: { $eq: ["$cancelAtPeriodEnd", true] },
      revoked: { $eq: ["$revoked", true] }, revocationReason: 1, revokedAt: 1,
      usable: { $and: [{ $ne: ["$revoked", true] }, { $gt: ["$until", now] }, { $in: ["$status", USABLE_STATUSES] }] },
    } },
    { $group: { _id: "$sale", plan: { $first: "$plan" }, priceId: { $first: "$priceId" }, purchasedAt: { $min: "$purchasedAt" },
      currentPriceId: { $first: "$currentPriceId" }, currentPlan: { $first: "$currentPlan" }, active: { $max: "$usable" }, cancel: { $max: "$cancel" },
      startedAt: { $min: "$startedAt" }, until: { $max: "$until" }, owner: { $first: "$owner" }, scope: { $first: "$scope" }, status: { $first: "$status" },
      subscription: { $max: "$subscription" }, revoked: { $max: "$revoked" }, revocationReason: { $max: "$revocationReason" }, revokedAt: { $max: "$revokedAt" },
      parts: { $push: "$part" } } },
  ];
}

export async function billingSummary(period: string, now = new Date(), lookup?: PriceLookup) {
  const since = periodStart(period, now);
  const unit = bucketFor(period);
  const group = { _id: { plan: "$plan", priceId: "$priceId" }, count: { $sum: 1 } };
  const [facets] = await BillingGrant.aggregate([
    ...saleStages(now),
    { $facet: {
      allTime: [{ $match: { purchasedAt: { $ne: null } } }, { $group: group }],
      period: [{ $match: { purchasedAt: since ? { $gte: since } : { $ne: null } } }, { $group: group }],
      active: [{ $match: { active: true } }, { $group: { ...group, _id: { plan: "$currentPlan", priceId: "$currentPriceId" }, cancelling: { $sum: { $cond: ["$cancel", 1, 0] } } } }],
      series: [{ $match: { purchasedAt: since ? { $gte: since } : { $ne: null } } },
        { $group: { _id: { bucket: { $dateTrunc: { date: "$purchasedAt", unit, startOfWeek: "monday" } }, plan: "$plan", priceId: "$priceId" }, count: { $sum: 1 } } }],
    } },
  ]);
  const rows = (name: string) => (facets?.[name] || []) as Row[];

  const available = revenueAvailable();
  const priceIds = [...rows("allTime"), ...rows("active")].map(r => r._id.priceId).filter((id): id is string => !!id);
  const prices = available ? await resolvePrices(priceIds, lookup) : new Map<string, Price>();
  // Sums the list price of `rows` per currency. Sales without a known price are left out and reported as missing.
  const money = (list: Row[], value = (p: Price, r: Row) => p.amount * r.count) => {
    const total: Money = {};
    for (const r of list) {
      const price = r._id.priceId ? prices.get(r._id.priceId) : undefined;
      if (price) add(total, price.currency, value(price, r));
    }
    return roundMoney(total);
  };
  const count = (list: Row[]) => list.reduce((n, r) => n + r.count, 0);

  const activeSubs = rows("active").filter(r => SUBSCRIPTION_PLANS.includes(r._id.plan));
  const mrr = available ? money(activeSubs, (p, r) => monthlyAmount(p, r._id.plan) * r.count) : {};
  const missingSales = count(rows("period").filter(r => !r._id.priceId || !prices.has(r._id.priceId)));
  // Count payment decisions, not mutable access grants. Operator reinstatement
  // leaves these records intact; distinct refunded renewals stay distinct.
  const reversals = await BillingRevocation.aggregate([
    ...(since ? [{ $match: { createdAt: { $gte: since } } }] : []),
    { $lookup: { from: BillingGrant.collection.name, localField: "_id", foreignField: "paymentIntentId",
      pipeline: [{ $match: { owner: { $type: "string" } } }, { $limit: 1 }], as: "checkout" } },
    { $lookup: { from: BillingGrant.collection.name, localField: "subscriptionId", foreignField: "_id",
      pipeline: [{ $match: { owner: { $type: "string" } } }, { $limit: 1 }], as: "subscription" } },
    { $match: { $or: [{ "checkout.0": { $exists: true } }, { "subscription.0": { $exists: true } }] } },
    { $group: { _id: "$reason", count: { $sum: 1 } } },
  ]);
  const missing = (list: Row[]) => count(list.filter(r => !r._id.priceId || !prices.has(r._id.priceId)));
  const inPeriod = rows("period"), allTime = rows("allTime");
  const result = {
    period, since, now, bucket: unit,
    subscriptions: {
      active: count(activeSubs),
      monthly: count(activeSubs.filter(r => r._id.plan === "author_monthly")),
      annual: count(activeSubs.filter(r => r._id.plan === "author_annual")),
      cancelling: activeSubs.reduce((n, r) => n + (r.cancelling || 0), 0),
      mrr, complete: available && missing(activeSubs) === 0,
    },
    sales: { count: count(inPeriod), revenue: available ? money(inPeriod) : {}, complete: available && missing(inPeriod) === 0 },
    allTime: { count: count(allTime), revenue: available ? money(allTime) : {}, complete: available && missing(allTime) === 0 },
    reversals: {
      refunds: count(reversals.filter(r => r._id === "full_refund")),
      disputes: count(reversals.filter(r => r._id === "dispute")),
    },
    plans: planRows(rows, available ? (list: Row[]) => money(list) : () => ({}), list => available && missing(list) === 0),
    series: fillSeries(rows("series") as unknown as SeriesRow[], since, now, unit, available ? id => (id ? prices.get(id) : undefined) : null),
    revenue: { available, reason: available ? null : "stripe_not_configured", missingSales: available ? missingSales : 0, missingAllTimeSales: available ? missing(allTime) : 0, missingSubscriptions: available ? missing(activeSubs) : 0, basis: "list_price" },
  };
  return result;
}

function planRows(rows: (name: string) => Row[], money: (list: Row[]) => Money, complete: (list: Row[]) => boolean) {
  const names = new Map(billingPlans().map(p => [p.id as string, p.name]));
  const ids = [...names.keys()];
  for (const name of ["allTime", "active", "period"]) for (const r of rows(name)) if (!ids.includes(r._id.plan)) ids.push(r._id.plan);
  return ids.map(planId => {
    const of = (name: string) => rows(name).filter(r => r._id.plan === planId);
    const sum = (list: Row[]) => list.reduce((n, r) => n + r.count, 0);
    return { planId, name: names.get(planId) || planId, family: planFamily(planId),
      revenueComplete: complete(of("period")), allTimeRevenueComplete: complete(of("allTime")),
      active: sum(of("active")), sales: sum(of("period")), revenue: money(of("period")),
      allTimeSales: sum(of("allTime")), allTimeRevenue: money(of("allTime")) };
  });
}

// One entry per bucket from the period start to now, with each family's sale
// count and list-price revenue per currency. `missing` counts sales whose price
// is unknown; `price` is null when Stripe is not configured.
export function fillSeries(rows: SeriesRow[], since: Date | null, now: Date, unit: Bucket, price: ((id?: string | null) => Price | undefined) | null) {
  const first = since || rows.reduce<Date | null>((min, r) => !min || r._id.bucket < min ? r._id.bucket : min, null);
  if (!first) return [];
  type Point = { date: Date; subscription: number; repository: number; conference: number; revenue: Record<Family, Money>; missing: number };
  const buckets = new Map<number, Point>();
  for (let d = truncate(first, unit); d <= now; d = nextBucket(d, unit)) {
    buckets.set(d.getTime(), { date: d, subscription: 0, repository: 0, conference: 0, revenue: { subscription: {}, repository: {}, conference: {} }, missing: 0 });
  }
  for (const r of rows) {
    const bucket = buckets.get(new Date(r._id.bucket).getTime());
    if (!bucket) continue;
    const family = planFamily(r._id.plan);
    bucket[family] += r.count;
    if (!price) continue;
    const p = price(r._id.priceId);
    if (p) add(bucket.revenue[family], p.currency, p.amount * r.count);
    else bucket.missing += r.count;
  }
  return [...buckets.values()];
}

// Webhook inbox state and payment reversals waiting for an operator.
export async function billingWebhookHealth() {
  const [health, lastError, unreviewed, latest] = await Promise.all([
    billingHealth(),
    BillingEvent.findOne({ state: { $in: ["pending", "processing", "failed"] }, lastError: { $exists: true } })
      .sort({ nextAttemptAt: -1 }).select("type state lastError attempts receivedAt").lean(),
    BillingRevocation.countDocuments({ reviewed: false }),
    BillingRevocation.findOne({ reviewed: false }).sort({ createdAt: -1 }).select("reason createdAt").lean(),
  ]);
  return { ...health,
    lastError: lastError ? { type: lastError.type, state: lastError.state, error: lastError.lastError, attempts: lastError.attempts, receivedAt: lastError.receivedAt } : null,
    unreviewedRevocations: unreviewed, latestRevocation: latest ? { reason: latest.reason, createdAt: latest.createdAt } : null };
}

export type GrantQuery = { search?: unknown; page?: unknown; limit?: unknown; plan?: unknown; status?: unknown; state?: unknown; period?: unknown; owners?: string[] | null; sort?: unknown; direction?: unknown };
// Matched against sales (see saleStages), so the tabs count sales like the summary.
const STATE_FILTERS: Record<string, Record<string, unknown>> = {
  active: { revoked: false, active: true },
  expired: { revoked: false, active: false },
  revoked: { revoked: true },
};
const word = (v: unknown) => typeof v === "string" && /^[a-z0-9_]{1,40}$/.test(v) ? v : "";
// The filtered sale list. Only plain words reach the query, never operators.
// `grant` applies to grants before they are grouped into sales, `sale` after.
export function grantFilter(query: GrantQuery, now = new Date()) {
  const grant: Record<string, unknown> = {}, sale: Record<string, unknown> = {};
  const plan = word(query.plan), status = word(query.status), state = word(query.state), period = word(query.period);
  // A subscription matches both the plan it was sold as and its current plan.
  if (plan) sale.$or = [{ plan }, { currentPlan: plan }];
  if (status) sale.status = status;
  const since = period in BILLING_PERIODS ? periodStart(period, now) : null;
  if (since) sale.purchasedAt = { $gte: since };
  if (query.owners) grant.owner = { $in: query.owners };
  return { grant, sale, state: STATE_FILTERS[state] || null };
}
type Sale = { _id: string; plan: string; currentPlan: string; priceId?: string | null; startedAt?: Date | null; until?: Date | null; owner?: string | null; scope?: string | null;
  status?: string | null; subscription: boolean; active: boolean; cancel: boolean; revoked: boolean; revocationReason?: string | null; revokedAt?: Date | null;
  parts: { planId: string; until?: Date | null }[] };
export async function billingGrants(query: GrantQuery, usernames: (ids: string[]) => Promise<Map<string, string>>, now = new Date(), lookup?: PriceLookup) {
  const page = Math.max(1, parseInt(String(query.page)) || 1);
  const limit = Math.min(Math.max(1, parseInt(String(query.limit)) || 25), 100);
  const sortField = String(query.sort) === "until" ? "until" : "startedAt";
  const { grant, sale, state } = grantFilter(query, now);
  const search = typeof query.search === "string" ? query.search.trim() : "";
  const userMatch = search ? [
    { $set: { userId: { $convert: { input: "$owner", to: "objectId", onError: null, onNull: null } } } },
    { $lookup: { from: UserModel.collection.name, localField: "userId", foreignField: "_id",
      pipeline: [{ $match: { username: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } } }, { $project: { _id: 1 } }], as: "user" } },
    { $match: { "user.0": { $exists: true } } },
  ] : [];
  const listed = state ? [{ $match: state }] : [];
  const [[result], statuses] = await Promise.all([BillingGrant.aggregate([
    { $match: grant }, ...userMatch, ...saleStages(now), { $match: sale },
    { $facet: {
      total: [...listed, { $count: "count" }],
      sales: [...listed, { $sort: { [sortField]: query.direction === "asc" ? 1 : -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }],
      ...Object.fromEntries(Object.entries(STATE_FILTERS).map(([key, f]) => [key, [{ $match: f }, { $count: "count" }]])),
    } },
  ]), BillingGrant.distinct("status")]);
  const sales = (result?.sales || []) as Sale[];
  const names = await usernames([...new Set(sales.map(s => s.owner).filter((o): o is string => !!o))]);
  const available = revenueAvailable();
  const prices = available ? await resolvePrices(sales.map(s => s.priceId).filter((id): id is string => !!id), lookup) : new Map<string, Price>();
  const ends = (until?: Date | null) => {
    const never = !!until && until.getTime() >= REPO_NEVER_UNTIL.getTime();
    return { until: never ? null : until || null, never };
  };
  const results = sales.map(s => {
    const [kind, target] = String(s.scope || "").split(/:(.*)/s);
    const pack = s.plan === "repo_pack";
    const planId = pack ? "repo_pack" : s.currentPlan;
    const price = s.priceId ? prices.get(s.priceId) : undefined;
    return {
      id: createHash("sha256").update(String(s._id)).digest("hex").slice(0, 12),
      user: (s.owner && names.get(s.owner)) || null,
      planId, pack, family: planFamily(planId), subscription: !!s.subscription,
      parts: pack ? s.parts.map(p => ({ planId: p.planId, ...ends(p.until) })).sort((a, b) => PACK_PLANS.indexOf(a.planId as PlanId) - PACK_PLANS.indexOf(b.planId as PlanId)) : [],
      status: s.status || null, state: s.revoked ? "revoked" : s.active ? "active" : "expired",
      purchasedAt: s.startedAt || null, ...ends(s.until),
      cancelAtPeriodEnd: !!s.cancel, revoked: !!s.revoked, revocationReason: s.revocationReason || null, revokedAt: s.revokedAt || null,
      scope: kind === "repo" || kind === "conference" ? { kind, id: target } : { kind: "account", id: null },
      // The sale's list price, the one the summary sums; per period for a subscription.
      amount: price ? { value: price.amount, currency: price.currency, interval: s.subscription ? price.interval || (s.plan === "author_annual" ? "year" : "month") : null, intervalCount: price.intervalCount } : null,
      amountMissing: price ? null : !available ? "stripe_not_configured" : s.priceId ? "unresolved" : "unrecorded",
    };
  });
  const total = result?.total[0]?.count || 0;
  const stateCounts = Object.fromEntries(Object.keys(STATE_FILTERS).map(key => [key, result?.[key][0]?.count || 0]));
  return { page, limit, total, results, stateCounts, statuses: statuses.filter(Boolean).sort() };
}
