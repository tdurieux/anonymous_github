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
    const { filter, state } = report.grantFilter({ plan: { $ne: "x" }, status: "active", state: "revoked" });
    expect(filter).to.deep.equal({ status: "active" });
    expect(state).to.deep.equal({ revoked: true });
    expect(report.grantFilter({ plan: "repo_pack", status: "$where" }).filter).to.deep.equal({ _id: { $regex: "^cs_[^:]+:(repo_slot|author_pass|repo_extend)$" } });
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
      { _id: "sub_m", owner: a, scope: `user:${a}`, planId: "author_monthly", subscriptionId: "sub_m", priceId: "price_monthly", status: "active", until: later(20), purchasedAt: ago(3) },
      { _id: "sub_y", owner: b, scope: `user:${b}`, planId: "author_annual", subscriptionId: "sub_y", priceId: "price_annual", status: "active", until: later(200), purchasedAt: ago(100), cancelAtPeriodEnd: true },
      { _id: "sub_old", owner: b, scope: `user:${b}`, planId: "author_monthly", subscriptionId: "sub_old", priceId: "price_monthly", status: "canceled", until: ago(40), purchasedAt: ago(400) },
      ...["repo_slot", "author_pass", "repo_extend"].map(part => ({ _id: `cs_pack:${part}`, owner: a, scope: "repo:paper-1", planId: part, paymentIntentId: "pi_pack", priceId: "price_pack", status: "paid", until: later(100), purchasedAt: ago(2) })),
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
    expect(s.series).to.have.length(31);
    const total = s.series.reduce((n, d) => n + d.subscription + d.repository + d.conference, 0);
    expect(total).to.equal(5);
    expect(s.series.reduce((n, d) => n + d.conference, 0)).to.equal(1);
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
    await BillingGrant.updateOne({ _id: "sub_y" }, { $set: { priceId: "price_missing" } });
    const s = await report.billingSummary("30d", now, lookup);
    expect(s.revenue).to.include({ missingSales: 0, missingAllTimeSales: 1, missingSubscriptions: 1 });
    expect(s.sales.complete).to.equal(true);
    expect(s.allTime.complete).to.equal(false);
    expect(s.subscriptions.complete).to.equal(false);
    expect(s.plans.find(p => p.planId === "author_annual")).to.include({ revenueComplete: true, allTimeRevenueComplete: false });
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

  it("filters, searches and paginates grants without exposing Stripe identifiers", async () => {
    const usernames = async ids => new Map((await User.find({ _id: { $in: ids } }).lean()).map(u => [String(u._id), u.username]));
    const all = await report.billingGrants({ limit: 4 }, usernames, now);
    expect(all.total).to.equal(9);
    expect(all.results).to.have.length(4);
    expect(all.stateCounts).to.deep.equal({ active: 7, expired: 1, revoked: 1 });
    expect(JSON.stringify(all)).not.to.match(/sub_m|pi_|cus_|price_/);
    expect(all.results[0]).to.include({ user: "alice-lab", planId: "repo_extend" });
    const page3 = await report.billingGrants({ limit: 4, page: 3 }, usernames, now);
    expect(page3.results).to.have.length(1);

    const revoked = await report.billingGrants({ state: "revoked" }, usernames, now);
    expect(revoked.results).to.have.length(1);
    expect(revoked.results[0]).to.include({ planId: "repo_never", never: true, until: null, revocationReason: "full_refund", user: "bob" });
    expect(revoked.results[0].scope).to.deep.equal({ kind: "repo", id: "other" });

    const pack = await report.billingGrants({ plan: "repo_pack" }, usernames, now);
    expect(pack.results.map(r => r.pack)).to.deep.equal([true, true, true]);
    const expired = await report.billingGrants({ state: "expired", status: "canceled" }, usernames, now);
    expect(expired.results.map(r => r.planId)).to.deep.equal(["author_monthly"]);
    const bobs = await report.billingGrants({ owners: [String(bob._id)], sort: "until", direction: "asc" }, usernames, now);
    expect(bobs.results.map(r => r.user)).to.deep.equal(["bob", "bob", "bob"]);
    expect(bobs.results[0].scope.kind).to.equal("account");
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
    expect(grants.body.total).to.equal(6);
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
