const { URL } = require("node:url");
const { expect } = require("chai");
require("ts-node/register/transpile-only");
const mongoose = require("mongoose");
const config = require("../src/config").default;
const { BillingGrant, BillingEvent, BillingRevocation } = require("../src/core/billing/models");
const User = require("../src/core/model/users/users.model").default;
const report = require("../src/core/billing/report");

const DAY = 86400000;

describe("admin billing report helpers", () => {
  it("groups plans into families and buckets by period", () => {
    expect(report.planFamily("author_annual")).to.equal("subscription");
    expect(report.planFamily("conference_large")).to.equal("conference");
    expect(report.planFamily("repo_pack")).to.equal("repository");
    expect(["7d", "30d", "90d", "12m", "all"].map(report.bucketFor)).to.deep.equal(["day", "day", "day", "week", "month"]);
    // Weeks start on Monday in UTC, like Mongo's $dateTrunc with startOfWeek: "monday".
    expect(report.truncate(new Date("2026-11-15T23:00:00Z"), "week").toISOString()).to.equal("2026-11-09T00:00:00.000Z");
    expect(report.truncate(new Date("2026-11-15T23:00:00Z"), "month").toISOString()).to.equal("2026-11-01T00:00:00.000Z");
  });
  it("normalizes recurring prices to a monthly amount", () => {
    expect(report.monthlyAmount({ amount: 1200, interval: "year", intervalCount: 1 })).to.equal(100);
    expect(report.monthlyAmount({ amount: 500, interval: "month", intervalCount: 1 })).to.equal(500);
    expect(report.monthlyAmount({ amount: 1200, interval: null, intervalCount: 1 }, "author_annual")).to.equal(100);
  });
  it("passes only plain words from the query string into the grant filter", () => {
    const { grant, sale, state } = report.grantFilter({ plan: { $ne: "x" }, status: "active", state: "revoked", period: { $gt: "" } });
    expect(grant).to.deep.equal({});
    expect(sale).to.deep.equal({ status: "active" });
    expect(state).to.deep.equal({ revoked: true });
    expect(report.grantFilter({ plan: "repo_pack", status: "$where" }).sale).to.deep.equal({ $or: [{ plan: "repo_pack" }, { currentPlan: "repo_pack" }] });
    const now = new Date("2026-11-16T15:00:00Z");
    expect(report.grantFilter({ period: "7d" }, now).sale).to.deep.equal({ purchasedAt: { $gte: new Date("2026-11-10T00:00:00Z") } });
    expect(report.grantFilter({ period: "1y" }, now).sale).to.deep.equal({});
  });
  it("draws N buckets for N days, ending with the current one", () => {
    const now = new Date("2026-11-16T15:00:00Z"); // a Monday
    const expected = { "7d": [7, "2026-11-10"], "30d": [30, "2026-10-18"], "90d": [90, "2026-08-19"], "12m": [52, "2025-11-24"] };
    for (const [period, [buckets, first]] of Object.entries(expected)) {
      const since = report.periodStart(period, now);
      const series = report.fillSeries([], since, now, report.bucketFor(period), null);
      expect(series, period).to.have.length(buckets);
      expect(since.toISOString(), period).to.equal(first + "T00:00:00.000Z");
      expect(series[0].date.getTime(), period).to.equal(since.getTime());
      expect(series.at(-1).date.toISOString(), period).to.equal(report.truncate(now, report.bucketFor(period)).toISOString());
    }
    expect(report.periodStart("all", now)).to.equal(null);
    const monthly = report.fillSeries([{ _id: { bucket: new Date("2025-09-01T00:00:00Z"), plan: "repo_slot" }, count: 1 }], null, now, "month", null);
    expect(monthly.map(d => d.date.toISOString().slice(0, 7))).to.have.length(15).and.to.include.members(["2025-09", "2026-11"]);
  });
  it("adds each bucket's revenue per family and currency, and counts unknown prices", () => {
    const now = new Date("2026-11-16T15:00:00Z");
    const day = new Date("2026-11-15T00:00:00Z");
    const prices = { p_eur: { amount: 500, currency: "eur" }, p_usd: { amount: 2000, currency: "usd" }, p_pack: { amount: 1500, currency: "eur" } };
    const rows = [
      { _id: { bucket: day, plan: "author_monthly", priceId: "p_eur" }, count: 2 },
      { _id: { bucket: day, plan: "repo_pack", priceId: "p_pack" }, count: 1 },
      { _id: { bucket: day, plan: "repo_never", priceId: "p_usd" }, count: 1 },
      { _id: { bucket: day, plan: "conference", priceId: "p_gone" }, count: 1 },
    ];
    const series = report.fillSeries(rows, report.periodStart("7d", now), now, "day", id => prices[id]);
    const bucket = series.find(d => d.date.getTime() === day.getTime());
    expect(bucket).to.include({ subscription: 2, repository: 2, conference: 1, missing: 1 });
    expect(bucket.revenue).to.deep.equal({ subscription: { eur: 1000 }, repository: { eur: 1500, usd: 2000 }, conference: {} });
    expect(report.fillSeries(rows, report.periodStart("7d", now), now, "day", null).find(d => d.date.getTime() === day.getTime()))
      .to.deep.include({ missing: 0, revenue: { subscription: {}, repository: {}, conference: {} } });
  });
  it("mounts the billing routes behind the administrator check", () => {
    const admin = require("../src/server/routes/admin").default;
    const billingRouter = require("../src/server/routes/admin-billing").default;
    const billing = admin.stack.findIndex(l => l.handle === billingRouter);
    // ensureAuthenticated and the isOwnerOrAdmin middleware come first.
    expect(billing).to.be.greaterThan(1);
    expect(admin.stack.slice(0, billing).filter(l => !l.route && l.handle.length >= 3).length).to.be.at.least(2);
  });
});

const uri = process.env.BILLING_TEST_MONGODB_URI;
(uri ? describe : describe.skip)("admin billing report with MongoDB", function () {
  this.timeout(20000);
  const original = { ...config };
  const now = new Date();
  const ago = days => new Date(now.getTime() - days * DAY);
  const later = days => new Date(now.getTime() + days * DAY);
  const prices = {
    price_monthly: { unit_amount: 500, currency: "eur", recurring: { interval: "month", interval_count: 1 } },
    price_annual: { unit_amount: 4800, currency: "eur", recurring: { interval: "year", interval_count: 1 } },
    price_pack: { unit_amount: 1500, currency: "eur" },
    price_never: { unit_amount: 2000, currency: "usd" },
    price_conf: { unit_amount: 30000, currency: "eur" },
  };
  let lookups;
  const lookup = async id => { lookups.push(id); if (!prices[id]) throw new Error("no such price"); return prices[id]; };
  let alice, bob;
  before(async () => {
    if (!/^billing_test_/.test(new URL(uri).pathname.slice(1))) throw new Error("Use a disposable billing_test_ database");
    await mongoose.connect(uri);
    await Promise.all([BillingGrant, BillingEvent, BillingRevocation, User].map(m => m.init()));
  });
  beforeEach(async () => {
    lookups = [];
    report.clearPriceCache();
    Object.assign(config, { BILLING_ENABLED: true, STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" });
    await Promise.all([BillingGrant, BillingEvent, BillingRevocation, User].map(m => m.deleteMany({})));
    [alice, bob] = await User.create([{ username: "alice-lab", accessTokens: {} }, { username: "bob" }]);
    const a = String(alice._id), b = String(bob._id);
    await BillingGrant.create([
      { _id: "sub_m", owner: a, scope: `user:${a}`, planId: "author_monthly", subscriptionId: "sub_m", priceId: "price_monthly", salePriceId: "price_monthly", salePlanId: "author_monthly", status: "active", until: later(20), purchasedAt: ago(3) },
      { _id: "sub_y", owner: b, scope: `user:${b}`, planId: "author_annual", subscriptionId: "sub_y", priceId: "price_annual", salePriceId: "price_annual", salePlanId: "author_annual", status: "active", until: later(200), purchasedAt: ago(100), cancelAtPeriodEnd: true },
      { _id: "sub_old", owner: b, scope: `user:${b}`, planId: "author_monthly", subscriptionId: "sub_old", priceId: "price_monthly", salePriceId: "price_monthly", salePlanId: "author_monthly", status: "canceled", until: ago(40), purchasedAt: ago(400) },
      ...["repo_slot", "author_pass", "repo_extend"].map(part => ({ _id: `cs_pack:${part}`, owner: a, scope: "repo:paper-1", planId: part, paymentIntentId: "pi_pack", priceId: "price_pack", status: "paid",
        until: { repo_slot: new Date("9999-12-31T00:00:00Z"), author_pass: later(178), repo_extend: later(363) }[part], purchasedAt: ago(2) })),
      { _id: "cs_never", owner: b, scope: "repo:other", planId: "repo_never", paymentIntentId: "pi_never", priceId: "price_never", status: "paid", until: new Date("9999-12-31T00:00:00Z"), purchasedAt: ago(5), revoked: true, revocationReason: "full_refund", revokedAt: ago(1) },
      { _id: "cs_conf", owner: a, scope: "conference:FSE26", planId: "conference", paymentIntentId: "pi_conf", priceId: "price_conf", status: "paid", until: later(60), purchasedAt: ago(10) },
      { _id: "cs_gone", owner: a, scope: "repo:paper-2", planId: "repo_extend", paymentIntentId: "pi_gone", priceId: "price_retired", status: "paid", until: later(10), purchasedAt: ago(1) },
    ]);
    await BillingRevocation.create({ _id: "pi_never", reason: "full_refund", createdAt: ago(1) });
  });
  after(async () => { Object.assign(config, original); await mongoose.disconnect(); });

  it("counts sales once per checkout, normalizes MRR and keeps currencies apart", async () => {
    const s = await report.billingSummary("30d", now, lookup);
    expect(s.subscriptions).to.deep.include({ active: 2, monthly: 1, annual: 1, cancelling: 1 });
    expect(s.subscriptions.mrr).to.deep.equal({ eur: 500 + 400 });
    // Monthly sub, pack (once), never, conference and the retired price: 5 sales in 30 days.
    expect(s.sales.count).to.equal(5);
    expect(s.sales.revenue).to.deep.equal({ eur: 500 + 1500 + 30000, usd: 2000 });
    expect(s.allTime.count).to.equal(7);
    expect(s.reversals).to.deep.equal({ refunds: 1, disputes: 0 });
    expect(s.revenue).to.include({ available: true, missingSales: 1 });
    const pack = s.plans.find(p => p.planId === "repo_pack");
    expect(pack).to.include({ active: 1, sales: 1, allTimeSales: 1 });
    expect(pack.revenue).to.deep.equal({ eur: 1500 });
    expect(s.plans.find(p => p.planId === "repo_slot").sales).to.equal(0);
    expect(s.series).to.have.length(30);
    const total = s.series.reduce((n, d) => n + d.subscription + d.repository + d.conference, 0);
    expect(total).to.equal(5);
    expect(s.series.reduce((n, d) => n + d.conference, 0)).to.equal(1);
    // Per-bucket revenue adds up to the period revenue; the retired price is the one missing sale.
    const revenue = {};
    for (const d of s.series) for (const family of Object.values(d.revenue)) for (const [c, v] of Object.entries(family)) revenue[c] = (revenue[c] || 0) + v;
    expect(revenue).to.deep.equal(s.sales.revenue);
    expect(s.series.reduce((n, d) => n + d.missing, 0)).to.equal(1);
    expect(s.series.find(d => d.repository === 1 && d.revenue.repository.eur).revenue.repository).to.deep.equal({ eur: 1500 });
    // One Stripe call per distinct price, then the cache.
    expect(lookups.sort()).to.deep.equal(["price_annual", "price_conf", "price_monthly", "price_never", "price_pack", "price_retired"]);
    lookups = [];
    await report.billingSummary("all", now, lookup);
    expect(lookups).to.deep.equal([]);
  });

  it("excludes never-paid subscriptions while retaining canceled paid sales", async () => {
    await BillingGrant.create(["incomplete", "incomplete_expired", "canceled"].map(status => ({
      _id: "sub_unpaid_" + status, planId: "author_monthly", subscriptionId: "sub_unpaid_" + status,
      priceId: "price_monthly", status, until: new Date(0), purchasedAt: ago(1),
    })));
    const s = await report.billingSummary("all", now, lookup);
    expect(s.sales.count).to.equal(7);
    expect(s.plans.find(p => p.planId === "author_monthly").allTimeSales).to.equal(2);
    expect(s.series.reduce((n, d) => n + d.subscription, 0)).to.equal(3);
  });

  it("retains reinstated refunds and counts separate renewal reversals", async () => {
    await BillingGrant.updateOne({ _id: "cs_never" }, { $set: { revoked: false }, $unset: { revocationReason: 1, revokedAt: 1 } });
    await BillingRevocation.updateOne({ _id: "pi_never" }, { $set: { reviewed: true } });
    await BillingRevocation.create([
      { _id: "pi_renewal1", subscriptionId: "sub_m", reason: "full_refund", createdAt: ago(60), reviewed: true },
      { _id: "pi_renewal2", subscriptionId: "sub_m", reason: "full_refund", createdAt: ago(2) },
      { _id: "pi_dispute", subscriptionId: "sub_m", reason: "dispute", createdAt: ago(1) },
    ]);
    expect((await report.billingSummary("30d", now, lookup)).reversals).to.deep.equal({ refunds: 2, disputes: 1 });
    expect((await report.billingSummary("all", now, lookup)).reversals).to.deep.equal({ refunds: 3, disputes: 1 });
  });

  it("marks missing historical and active prices independently of period sales", async () => {
    await BillingGrant.deleteOne({ _id: "cs_gone" });
    await BillingGrant.updateOne({ _id: "sub_y" }, { $set: { priceId: "price_missing", salePriceId: "price_missing" } });
    const s = await report.billingSummary("30d", now, lookup);
    expect(s.revenue).to.include({ missingSales: 0, missingAllTimeSales: 1, missingSubscriptions: 1 });
    expect(s.sales.complete).to.equal(true);
    expect(s.allTime.complete).to.equal(false);
    expect(s.subscriptions.complete).to.equal(false);
    expect(s.plans.find(p => p.planId === "author_annual")).to.include({ revenueComplete: true, allTimeRevenueComplete: false });
  });

  it("excludes unrelated Stripe reversals and unresolved subscription stubs", async () => {
    await BillingRevocation.create([
      { _id: "pi_external", reason: "full_refund", createdAt: ago(1) },
      { _id: "pi_stub", subscriptionId: "sub_stub", reason: "dispute", createdAt: ago(1) },
    ]);
    await BillingGrant.create({ _id: "sub_stub", revoked: true });
    expect((await report.billingSummary("all", now, lookup)).reversals).to.deep.equal({ refunds: 1, disputes: 0 });
  });

  it("keeps historical sales prices and plans separate from current MRR", async () => {
    await BillingGrant.updateOne({ _id: "sub_m" }, { $set: { priceId: "price_annual", planId: "author_annual" } });
    const s = await report.billingSummary("30d", now, lookup);
    expect(s.subscriptions.mrr).to.deep.equal({ eur: 800 });
    expect(s.sales.revenue.eur).to.equal(32000);
    expect(s.plans.find(p => p.planId === "author_monthly")).to.include({ active: 0, sales: 1 });
    expect(s.plans.find(p => p.planId === "author_annual")).to.include({ active: 2, sales: 0 });
    await BillingGrant.updateOne({ _id: "sub_m" }, { $unset: { salePriceId: 1, salePlanId: 1 } });
    const legacy = await report.billingSummary("30d", now, lookup);
    expect(legacy.sales.complete).to.equal(false);
    expect(legacy.subscriptions.complete).to.equal(true);
  });

  it("searches all matching users before grant pagination, including after 1000 nonbuyers", async () => {
    await User.insertMany(Array.from({ length: 1001 }, (_, i) => ({ username: "matching-" + i })));
    const buyer = await User.create({ username: "matching-buyer" });
    await BillingGrant.create({ _id: "cs_search", owner: String(buyer._id), planId: "repo_slot", status: "paid", until: later(1), purchasedAt: ago(1) });
    const names = async ids => new Map(ids.map(id => [id, "matching-buyer"]));
    const s = await report.billingGrants({ search: "MATCHING", limit: 1 }, names, now);
    expect(s.total).to.equal(1);
    expect(s.results).to.have.length(1);
    expect(s.results[0].user).to.equal("matching-buyer");
    expect(s.stateCounts).to.deep.equal({ active: 1, expired: 0, revoked: 0 });
    expect((await report.billingGrants({ search: "matching.*" }, names, now)).total).to.equal(0);
  });

  it("reports counts without revenue when Stripe is not configured", async () => {
    config.STRIPE_SECRET_KEY = "";
    const s = await report.billingSummary("7d", now, lookup);
    expect(lookups).to.deep.equal([]);
    expect(s.revenue).to.include({ available: false, reason: "stripe_not_configured" });
    expect(s.sales).to.deep.equal({ count: 4, revenue: {}, complete: false });
    expect(s.subscriptions.mrr).to.deep.equal({});
  });

  it("returns an empty report for a period without sales", async () => {
    await BillingGrant.deleteMany({});
    const s = await report.billingSummary("all", now, lookup);
    expect(s.sales.count).to.equal(0);
    expect(s.series).to.deep.equal([]);
    expect(s.plans.every(p => p.sales === 0 && p.active === 0)).to.equal(true);
  });

  it("lists one row per sale, a paper pack included, without exposing Stripe identifiers", async () => {
    const usernames = async ids => new Map((await User.find({ _id: { $in: ids } }).lean()).map(u => [String(u._id), u.username]));
    const all = await report.billingGrants({ limit: 4 }, usernames, now, lookup);
    // 9 grants, 7 sales: the pack's three grants are one row.
    expect(all.total).to.equal(7);
    expect(all.results).to.have.length(4);
    expect(all.stateCounts).to.deep.equal({ active: 5, expired: 1, revoked: 1 });
    expect(JSON.stringify(all)).not.to.match(/sub_m|pi_|cus_|price_/);
    expect(all.results[0]).to.include({ user: "alice-lab", planId: "repo_extend" });
    const page2 = await report.billingGrants({ limit: 4, page: 2 }, usernames, now, lookup);
    expect(page2.results).to.have.length(3);

    const revoked = await report.billingGrants({ state: "revoked" }, usernames, now, lookup);
    expect(revoked.results).to.have.length(1);
    expect(revoked.results[0]).to.include({ planId: "repo_never", never: true, until: null, revocationReason: "full_refund", user: "bob" });
    expect(revoked.results[0].scope).to.deep.equal({ kind: "repo", id: "other" });

    const pack = await report.billingGrants({ plan: "repo_pack" }, usernames, now, lookup);
    expect(pack.total).to.equal(1);
    expect(pack.results[0]).to.include({ planId: "repo_pack", pack: true, family: "repository", never: true, until: null, state: "active" });
    expect(pack.results[0].parts.map(p => [p.planId, p.never])).to.deep.equal([["repo_slot", true], ["author_pass", false], ["repo_extend", false]]);
    expect(new Date(pack.results[0].parts[1].until).getTime()).to.equal(later(178).getTime());
    // The parts are not sold separately.
    expect((await report.billingGrants({ plan: "repo_slot" }, usernames, now, lookup)).total).to.equal(0);
    const expired = await report.billingGrants({ state: "expired", status: "canceled" }, usernames, now, lookup);
    expect(expired.results.map(r => r.planId)).to.deep.equal(["author_monthly"]);
    const bobs = await report.billingGrants({ owners: [String(bob._id)], sort: "until", direction: "asc" }, usernames, now, lookup);
    expect(bobs.results.map(r => r.user)).to.deep.equal(["bob", "bob", "bob"]);
    expect(bobs.results[0].scope.kind).to.equal("account");
  });

  it("shows each sale's list price, once per pack and per period for subscriptions", async () => {
    const usernames = async () => new Map();
    const { results } = await report.billingGrants({ limit: 100 }, usernames, now, lookup);
    const byPlan = Object.fromEntries(results.filter(r => r.state !== "expired").map(r => [r.planId, r]));
    expect(byPlan.repo_pack.amount).to.deep.equal({ value: 1500, currency: "eur", interval: null, intervalCount: 1 });
    expect(byPlan.author_monthly.amount).to.deep.equal({ value: 500, currency: "eur", interval: "month", intervalCount: 1 });
    expect(byPlan.author_annual.amount).to.include({ value: 4800, interval: "year" });
    expect(byPlan.repo_never.amount).to.include({ value: 2000, currency: "usd" });
    expect(byPlan.repo_extend).to.include({ amount: null, amountMissing: "unresolved" });
    // Resolved once per distinct price, then cached.
    expect(lookups.filter(id => id === "price_pack")).to.have.length(1);
    config.STRIPE_SECRET_KEY = "";
    const off = await report.billingGrants({ plan: "repo_pack" }, usernames, now, lookup);
    expect(off.results[0]).to.include({ amount: null, amountMissing: "stripe_not_configured" });
  });

  it("reconciles the chart, the plans, the tile and the list for each period", async () => {
    const usernames = async () => new Map();
    for (const period of ["7d", "30d"]) {
      const s = await report.billingSummary(period, now, lookup);
      const chart = s.series.reduce((n, d) => n + d.subscription + d.repository + d.conference, 0);
      const plans = s.plans.reduce((n, p) => n + p.sales, 0);
      const list = await report.billingGrants({ period }, usernames, now, lookup);
      expect([chart, plans, list.total], period).to.deep.equal([s.sales.count, s.sales.count, s.sales.count]);
      expect(list.results.reduce((n, r) => n + (r.amount?.currency === "eur" ? r.amount.value : 0), 0), period).to.equal(s.sales.revenue.eur);
    }
    expect((await report.billingSummary("7d", now, lookup)).sales.count).to.equal(4);
  });

  it("serves the summary and the grant list through the admin router", async () => {
    await BillingEvent.create([{ _id: "test:platform:evt_1", eventId: "evt_1", type: "invoice.paid", state: "failed", attempts: 12, lastError: "api_error:rate_limit", receivedAt: ago(1) },
      { _id: "test:platform:evt_2", eventId: "evt_2", type: "checkout.session.completed", state: "pending", receivedAt: new Date(now.getTime() - 120000) }]);

    const router = require("../src/server/routes/admin-billing").default;
    const call = async (path, query) => {
      const handler = router.stack.find(l => l.route?.path === path).route.stack.at(-1).handle;
      let body, status = 200;
      const res = { set() { return res; }, status(code) { status = code; return res; }, json(data) { body = data; return res; } };
      await handler({ query }, res);
      return { body, status };
    };
    const summary = await call("/summary", { period: { $gt: "" } });
    expect(summary.body.period).to.equal("30d");
    expect(summary.body.webhooks).to.include({ pending: 1, failed: 1, unreviewedRevocations: 1 });
    expect(summary.body.webhooks.oldestPendingSeconds).to.be.at.least(119);
    expect(summary.body.webhooks.lastError).to.include({ type: "invoice.paid", error: "api_error:rate_limit", state: "failed" });
    const grants = await call("/grants", { search: "ALICE", limit: "100" });
    expect(grants.body.total).to.equal(4);
    expect(grants.body.results.every(r => r.user === "alice-lab")).to.equal(true);
    const none = await call("/grants", { search: "nobody" });
    expect(none.body.total).to.equal(0);
  });

  it("uses the purchase date index to list grants", async () => {
    await BillingGrant.createIndexes();
    const plan = await BillingGrant.find({}).sort({ purchasedAt: -1, _id: -1 }).limit(25).explain("queryPlanner");
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).to.include("purchasedAt_-1");
  });
});
