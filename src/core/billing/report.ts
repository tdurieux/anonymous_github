import { createHash } from "crypto";
import config from "../../config";
import { BillingEvent, BillingGrant, BillingRevocation } from "./models";
import { billingHealth } from "./events";
import { stripeClient } from "./stripe";
import { billingPlans, CONFERENCE_PLANS, REPO_NEVER_UNTIL } from "./config";

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
  if (SUBSCRIPTION_PLANS.includes(planId || "")) return "subscription";
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

export async function billingSummary(period: string, now = new Date(), lookup?: PriceLookup) {
  const days = BILLING_PERIODS[period];
  const since = days == null ? null : new Date(now.getTime() - days * 86400_000);
  const unit = bucketFor(period);
  const isPack = { $regexMatch: { input: { $toString: "$_id" }, regex: PACK_PART } };
  const group = { _id: { plan: "$plan", priceId: "$priceId" }, count: { $sum: 1 } };
  const [facets] = await BillingGrant.aggregate([
    { $project: {
      sale: { $cond: [isPack, { $arrayElemAt: [{ $split: ["$_id", ":"] }, 0] }, "$_id"] },
      plan: { $cond: [isPack, "repo_pack", { $ifNull: ["$planId", "unknown"] }] },
      priceId: 1, purchasedAt: 1, reason: "$revocationReason",
      // Checkout-time reversals carry no revocation date; their purchase date stands in.
      revokedAt: { $ifNull: ["$revokedAt", "$purchasedAt"] },
      revoked: { $eq: ["$revoked", true] }, cancel: { $eq: ["$cancelAtPeriodEnd", true] },
      usable: { $and: [{ $ne: ["$revoked", true] }, { $gt: ["$until", now] }, { $in: ["$status", USABLE_STATUSES] }] },
    } },
    { $group: { _id: "$sale", plan: { $first: "$plan" }, priceId: { $first: "$priceId" }, purchasedAt: { $min: "$purchasedAt" },
      revoked: { $max: "$revoked" }, revokedAt: { $max: "$revokedAt" }, reason: { $min: "$reason" }, active: { $max: "$usable" }, cancel: { $max: "$cancel" } } },
    { $facet: {
      allTime: [{ $match: { purchasedAt: { $ne: null } } }, { $group: group }],
      period: [{ $match: { purchasedAt: since ? { $gte: since } : { $ne: null } } }, { $group: group }],
      active: [{ $match: { active: true } }, { $group: { ...group, cancelling: { $sum: { $cond: ["$cancel", 1, 0] } } } }],
      reversals: [{ $match: { revoked: true, ...(since ? { revokedAt: { $gte: since } } : {}) } },
        { $group: { _id: { plan: "$plan", priceId: "$priceId", reason: "$reason" }, count: { $sum: 1 } } }],
      series: [{ $match: { purchasedAt: since ? { $gte: since } : { $ne: null } } },
        { $group: { _id: { bucket: { $dateTrunc: { date: "$purchasedAt", unit, startOfWeek: "monday" } }, plan: "$plan" }, count: { $sum: 1 } } }],
    } },
  ]);
  const rows = (name: string) => (facets?.[name] || []) as Row[];

  const available = revenueAvailable();
  const priceIds = [...rows("allTime"), ...rows("active"), ...rows("reversals")].map(r => r._id.priceId).filter((id): id is string => !!id);
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
  const reversals = rows("reversals");
  const inPeriod = rows("period"), allTime = rows("allTime");
  const result = {
    period, since, now, bucket: unit,
    subscriptions: {
      active: count(activeSubs),
      monthly: count(activeSubs.filter(r => r._id.plan === "author_monthly")),
      annual: count(activeSubs.filter(r => r._id.plan === "author_annual")),
      cancelling: activeSubs.reduce((n, r) => n + (r.cancelling || 0), 0),
      mrr,
    },
    sales: { count: count(inPeriod), revenue: available ? money(inPeriod) : {} },
    allTime: { count: count(allTime), revenue: available ? money(allTime) : {} },
    reversals: {
      refunds: count(reversals.filter(r => r._id.reason !== "dispute")),
      disputes: count(reversals.filter(r => r._id.reason === "dispute")),
      amount: available ? money(reversals) : {},
    },
    plans: planRows(rows, available ? (list: Row[]) => money(list) : () => ({})),
    series: fillSeries(rows("series") as unknown as { _id: { bucket: Date; plan: string }; count: number }[], since, now, unit),
    revenue: { available, reason: available ? null : "stripe_not_configured", missingSales: available ? missingSales : 0, basis: "list_price" },
  };
  return result;
}

function planRows(rows: (name: string) => Row[], money: (list: Row[]) => Money) {
  const names = new Map(billingPlans().map(p => [p.id as string, p.name]));
  const ids = [...names.keys()];
  for (const name of ["allTime", "active", "period"]) for (const r of rows(name)) if (!ids.includes(r._id.plan)) ids.push(r._id.plan);
  return ids.map(planId => {
    const of = (name: string) => rows(name).filter(r => r._id.plan === planId);
    const sum = (list: Row[]) => list.reduce((n, r) => n + r.count, 0);
    return { planId, name: names.get(planId) || planId, family: planFamily(planId),
      active: sum(of("active")), sales: sum(of("period")), revenue: money(of("period")),
      allTimeSales: sum(of("allTime")), allTimeRevenue: money(of("allTime")) };
  });
}

function fillSeries(rows: { _id: { bucket: Date; plan: string }; count: number }[], since: Date | null, now: Date, unit: Bucket) {
  const first = since || rows.reduce<Date | null>((min, r) => !min || r._id.bucket < min ? r._id.bucket : min, null);
  if (!first) return [];
  const buckets = new Map<number, { date: Date; subscription: number; repository: number; conference: number }>();
  for (let d = truncate(first, unit); d <= now; d = nextBucket(d, unit)) buckets.set(d.getTime(), { date: d, subscription: 0, repository: 0, conference: 0 });
  for (const r of rows) {
    const bucket = buckets.get(new Date(r._id.bucket).getTime());
    if (bucket) bucket[planFamily(r._id.plan)] += r.count;
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

export type GrantQuery = { page?: unknown; limit?: unknown; plan?: unknown; status?: unknown; state?: unknown; owners?: string[] | null; sort?: unknown; direction?: unknown };
const STATE_FILTERS = (now: Date): Record<string, Record<string, unknown>> => ({
  active: { revoked: { $ne: true }, until: { $gt: now }, status: { $in: USABLE_STATUSES } },
  expired: { revoked: { $ne: true }, $or: [{ until: { $not: { $gt: now } } }, { status: { $nin: USABLE_STATUSES } }] },
  revoked: { revoked: true },
});
const word = (v: unknown) => typeof v === "string" && /^[a-z_]{1,40}$/.test(v) ? v : "";
// The filtered grant list. Only plain words reach the query, never operators.
export function grantFilter(query: GrantQuery, now = new Date()) {
  const filter: Record<string, unknown> = {};
  const plan = word(query.plan), status = word(query.status), state = word(query.state);
  if (plan === "repo_pack") filter._id = { $regex: PACK_PART };
  else if (plan) filter.planId = plan;
  if (status) filter.status = status;
  if (query.owners) filter.owner = { $in: query.owners };
  return { filter, state: STATE_FILTERS(now)[state] || null };
}
export async function billingGrants(query: GrantQuery, usernames: (ids: string[]) => Promise<Map<string, string>>, now = new Date()) {
  const page = Math.max(1, parseInt(String(query.page)) || 1);
  const limit = Math.min(Math.max(1, parseInt(String(query.limit)) || 25), 100);
  const sortField = ["purchasedAt", "until"].includes(String(query.sort)) ? String(query.sort) : "purchasedAt";
  const { filter, state } = grantFilter(query, now);
  const states = STATE_FILTERS(now);
  const listed = state ? { $and: [filter, state] } : filter;
  const [total, grants, stateCounts, statuses] = await Promise.all([
    BillingGrant.countDocuments(listed),
    BillingGrant.find(listed).sort({ [sortField]: query.direction === "asc" ? 1 : -1, _id: -1 }).skip((page - 1) * limit).limit(limit)
      .select("owner scope planId status until cancelAtPeriodEnd purchasedAt revoked revocationReason revokedAt subscriptionId").lean(),
    Promise.all(Object.entries(states).map(async ([key, f]) => [key, await BillingGrant.countDocuments({ $and: [filter, f] })] as const)),
    BillingGrant.distinct("status"),
  ]);
  const names = await usernames([...new Set(grants.map(g => g.owner).filter((o): o is string => !!o))]);
  const usable = (g: { revoked?: boolean | null; until?: Date | null; status?: string | null }) => !g.revoked && !!g.until && g.until > now && USABLE_STATUSES.includes(g.status || "");
  const results = grants.map(g => {
    const [kind, target] = String(g.scope || "").split(/:(.*)/s);
    const never = !!g.until && g.until.getTime() >= REPO_NEVER_UNTIL.getTime();
    const pack = new RegExp(PACK_PART).test(String(g._id));
    return {
      id: createHash("sha256").update(String(g._id)).digest("hex").slice(0, 12),
      user: (g.owner && names.get(g.owner)) || null,
      planId: g.planId || "unknown", pack, family: planFamily(g.planId), subscription: !!g.subscriptionId,
      status: g.status || null, state: g.revoked ? "revoked" : usable(g) ? "active" : "expired",
      purchasedAt: g.purchasedAt || null, until: never ? null : g.until || null, never,
      cancelAtPeriodEnd: !!g.cancelAtPeriodEnd, revoked: !!g.revoked, revocationReason: g.revocationReason || null, revokedAt: g.revokedAt || null,
      scope: kind === "repo" || kind === "conference" ? { kind, id: target } : { kind: "account", id: null },
    };
  });
  return { page, limit, total, results, stateCounts: Object.fromEntries(stateCounts), statuses: statuses.filter(Boolean).sort() };
}
