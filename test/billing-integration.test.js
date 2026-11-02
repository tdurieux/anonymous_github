const { URL } = require("node:url");
const { setTimeout } = require("node:timers");
const { expect } = require("chai");
require("ts-node/register/transpile-only");
const mongoose = require("mongoose");
const config = require("../src/config").default;
const { BillingAccount, BillingGrant, BillingQuota, BillingLock, BillingEvent, BillingRevocation, BillingDraft } = require("../src/core/billing/models");
const Repo = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const Conference = require("../src/core/model/conference/conferences.model").default;
const { reserveRepository, allowance, assertConferenceAdmission } = require("../src/core/billing/quotas");
const { fulfillCheckout, syncSubscription, createCheckout, processBillingEvent } = require("../src/core/billing/stripe");
const uri = process.env.BILLING_TEST_MONGODB_URI;
const owner = "507f1f77bcf86cd799439011";
const future = () => new Date(Date.now() + 86400000);
async function rejects(promise, message) {
  try { await promise; throw new Error("Expected rejection"); } catch (error) { expect(error.message).to.equal(message); }
}
(uri ? describe : describe.skip)("billing with MongoDB", function () {
  this.timeout(15000);
  const original = { ...config };
  before(async () => {
    if (!/^billing_test_/.test(new URL(uri).pathname.slice(1))) throw new Error("Use a disposable billing_test_ database");
    await mongoose.connect(uri);
    await Promise.all([BillingAccount, BillingGrant, BillingQuota, BillingLock, BillingEvent, BillingRevocation, BillingDraft, Repo, Conference].map(m => m.init()));
  });
  beforeEach(async () => {
    Object.assign(config, { BILLING_ENABLED: true, FREE_AUTHOR_REPOSITORIES: 3, FREE_AUTHOR_STORAGE: 100,
      PAID_AUTHOR_STORAGE: 1000, PAID_AUTHOR_REPOSITORIES: 20, STRIPE_AUTHOR_MONTHLY_PRICE: "price_monthly", STRIPE_AUTHOR_PASS_PRICE: "price_pass", STRIPE_CONFERENCE_PRICE: "price_conf" });
    await Promise.all([BillingAccount, BillingGrant, BillingQuota, BillingLock, BillingEvent, BillingRevocation, BillingDraft, Repo, Conference].map(m => m.deleteMany({})));
    await BillingAccount.create({ _id: owner, customerId: "cus_owner" });
  });
  after(async () => { Object.assign(config, original); await mongoose.disconnect(); });
  it("atomically admits only three concurrent repositories", async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reserveRepository(owner, `repo-${i}`, 10)));
    expect(results.filter(r => r.status === "fulfilled")).to.have.length(3);
    expect((await BillingQuota.findById(`user:${owner}`)).allocations).to.have.length(3);
  });
  it("atomically caps storage and never shrinks a concurrent reservation", async () => {
    const results = await Promise.allSettled([reserveRepository(owner, "a", 60), reserveRepository(owner, "b", 60)]);
    expect(results.filter(r => r.status === "fulfilled")).to.have.length(1);
    const ledger = await BillingQuota.findById(`user:${owner}`);
    const id = ledger.allocations[0].repoId;
    await Promise.all([reserveRepository(owner, id, 90), reserveRepository(owner, id, 1)]);
    expect((await BillingQuota.findById(`user:${owner}`)).allocations[0].bytes).to.equal(90);
  });
  it("counts legacy repositories and releases removed repositories", async () => {
    await Repo.create(["one", "two", "three"].map(repoId => ({ repoId, owner, status: "ready", size: { storage: 10 } })));
    await rejects(reserveRepository(owner, "four", 1), "quota_exceeded");
    await Repo.updateOne({ repoId: "one" }, { $set: { status: "removed" } });
    await reserveRepository(owner, "four", 1);
    expect((await BillingQuota.findById(`user:${owner}`)).allocations.map(a => a.repoId)).not.to.include("one");
  });
  it("charges shared repositories only to their owner, regardless of coauthor subscriptions", async () => {
    const collaborator = "507f1f77bcf86cd799439012";
    await Repo.create(["one", "two", "three"].map(repoId => ({
      repoId, owner, status: "ready", size: { storage: 10 },
      coauthors: [{ username: "collaborator", githubId: "42" }],
    })));
    // A collaborator can create their own repository even when the owner is full.
    await reserveRepository(collaborator, "own-work", 10);
    expect((await BillingQuota.findById(`user:${collaborator}`)).allocations.map(a => a.repoId)).to.deep.equal(["own-work"]);
    await BillingGrant.create({ _id: "coauthor-sub", owner: collaborator,
      scope: `user:${collaborator}`, status: "active", until: future(), planId: "author_monthly" });
    expect((await allowance(owner, "one")).plan).to.equal("free");
    await rejects(reserveRepository(owner, "four", 1), "quota_exceeded");
    // Editing shared work at the owner's count cap is allowed if its bytes fit.
    await reserveRepository(owner, "one", 20);
    await rejects(reserveRepository(owner, "one", 90), "quota_exceeded");
  });
  it("uses a conference allowance before an author's subscription", async () => {
    await BillingGrant.create([{ _id: "sub", owner, scope: `user:${owner}`, status: "active", until: future(), planId: "author_monthly" },
      { _id: "conf", owner, scope: "conference:CONF", status: "paid", until: future(), planId: "conference" }]);
    expect((await allowance(owner, "repo", "CONF")).scope).to.equal("conference:CONF");
    await BillingGrant.updateOne({ _id: "conf" }, { $set: { revoked: true } });
    expect((await allowance(owner, "repo", "CONF")).scope).to.equal(`user:${owner}`);
  });
  it("requires the owner's recurring subscription for never expiration", async () => {
    const { neverExpirationDeadline, NEVER_EXPIRATION_GRACE_MS } = require("../src/core/billing/expiration");
    await rejects(neverExpirationDeadline(owner), "subscription_required_for_never_expiration");
    await BillingGrant.create({ _id: "pass-only", owner, scope: "repo:repo", status: "paid", until: future(), planId: "author_pass" });
    await rejects(neverExpirationDeadline(owner), "subscription_required_for_never_expiration");
    const until = future();
    await BillingGrant.create({ _id: "author", owner, scope: `user:${owner}`, status: "active", until, planId: "author_annual" });
    expect((await neverExpirationDeadline(owner)).getTime()).to.equal(until.getTime() + NEVER_EXPIRATION_GRACE_MS);
  });
  it("renews never expiration, honors 90 days of grace and leaves legacy links alone", async () => {
    const { reconcileNeverExpiration, NEVER_EXPIRATION_GRACE_MS } = require("../src/core/billing/expiration");
    const until = future();
    const oldDeadline = new Date(Date.now() + 1000);
    await Repo.create([{ repoId: "paid-never", owner, status: "ready", options: { expirationMode: "never" }, billingNeverExpiresUntil: oldDeadline },
      { repoId: "legacy-never", owner, status: "ready", options: { expirationMode: "never" } }]);
    await BillingGrant.create({ _id: "author", owner, scope: `user:${owner}`, status: "active", until, planId: "author_monthly" });
    await reconcileNeverExpiration();
    const deadline = new Date(until.getTime() + NEVER_EXPIRATION_GRACE_MS);
    expect((await Repo.findOne({ repoId: "paid-never" })).billingNeverExpiresUntil.getTime()).to.equal(deadline.getTime());
    await reconcileNeverExpiration(new Date(deadline.getTime() - 1));
    expect((await Repo.findOne({ repoId: "paid-never" })).options.expirationMode).to.equal("never");
    await reconcileNeverExpiration(deadline, async () => {});
    const expired = await Repo.findOne({ repoId: "paid-never" });
    expect(expired.options.expirationMode).to.equal("remove");
    expect(expired.options.expirationDate.getTime()).to.equal(deadline.getTime());
    expect((await Repo.findOne({ repoId: "legacy-never" })).options.expirationMode).to.equal("never");
  });
  function session(status = "paid") {
    return { id: "cs_pass", metadata: { application: "anonymous-github", owner, planId: "author_pass", target: "repo" },
      customer: "cus_owner", status: "complete", payment_status: status, created: Math.floor(Date.now() / 1000),
      line_items: { data: [{ price: { id: "price_pass" }, quantity: 1 }] }, payment_intent: { id: "pi_pass", latest_charge: { amount_refunded: 0, disputed: false } } };
  }
  it("ignores an unfinished recurring Checkout before Stripe assigns a subscription", async () => {
    const stripe = { checkout: { sessions: { retrieve: async () => ({
      id: "cs_open", metadata: { application: "anonymous-github", owner, planId: "author_monthly" },
      customer: "cus_owner", status: "open", payment_status: "unpaid", subscription: null,
    }) } } };
    await fulfillCheckout("cs_open", stripe);
    expect(await BillingGrant.countDocuments()).to.equal(0);
  });
  it("ignores unpaid checkout and fulfills duplicate deliveries exactly once", async () => {
    let value = session("unpaid");
    const stripe = { checkout: { sessions: { retrieve: async () => value } } };
    await fulfillCheckout("cs_pass", stripe);
    expect(await BillingGrant.countDocuments()).to.equal(0);
    value = session();
    await Promise.all([fulfillCheckout("cs_pass", stripe), fulfillCheckout("cs_pass", stripe)]);
    const grant = await BillingGrant.findById("cs_pass");
    expect(await BillingGrant.countDocuments()).to.equal(1);
    expect(grant.scope).to.equal("repo:repo");
    expect(grant.until.getTime()).to.equal(value.created * 1000 + 180 * 86400000);
  });
  it("does not reactivate a refunded pass on a checkout replay", async () => {
    const value = session();
    const stripe = { checkout: { sessions: { retrieve: async () => value } } };
    await fulfillCheckout("cs_pass", stripe);
    await processBillingEvent({ type: "charge.refunded", data: { object: { payment_intent: "pi_pass" } } }, { ...stripe, invoicePayments: { list: async () => ({ data: [] }) } });
    await fulfillCheckout("cs_pass", stripe);
    expect((await BillingGrant.findById("cs_pass")).revoked).to.equal(true);
  });
  it("rejects a checkout for a different Stripe customer", async () => {
    const value = session(); value.customer = "cus_other";
    await rejects(fulfillCheckout("cs_pass", { checkout: { sessions: { retrieve: async () => value } } }), "billing_customer_mismatch");
  });
  function subscription(overrides = {}) {
    return { id: "sub_owner", metadata: { application: "anonymous-github", owner }, customer: "cus_owner", status: "active",
      latest_invoice: { status: "paid" }, items: { data: [{ price: { id: "price_monthly" }, current_period_end: Math.floor(future().getTime() / 1000) }] }, cancel_at_period_end: false, ...overrides };
  }
  it("recognizes portal cancellations scheduled with cancel_at", async () => {
    await syncSubscription("sub_owner", { subscriptions: { retrieve: async () => subscription({
      cancel_at_period_end: false, cancel_at: Math.floor(future().getTime() / 1000),
    }) } });
    expect((await BillingGrant.findById("sub_owner")).cancelAtPeriodEnd).to.equal(true);
    expect((await allowance(owner)).plan).to.equal("author_monthly");
  });
  it("honors paid subscription periods, cancellation and renewal failure", async () => {
    let value = subscription();
    const stripe = { subscriptions: { retrieve: async () => value } };
    await syncSubscription("sub_owner", stripe);
    expect((await allowance(owner)).plan).to.equal("author_monthly");
    const paidThrough = (await BillingGrant.findById("sub_owner")).until;
    value = subscription({ status: "past_due", latest_invoice: { status: "open" } });
    value.items.data[0].current_period_end += 86400 * 30;
    await syncSubscription("sub_owner", stripe);
    expect((await BillingGrant.findById("sub_owner")).until).to.deep.equal(paidThrough);
    value = subscription({ cancel_at_period_end: true });
    await syncSubscription("sub_owner", stripe);
    expect((await allowance(owner)).plan).to.equal("author_monthly");
    value = subscription({ status: "canceled" });
    await syncSubscription("sub_owner", stripe);
    expect((await allowance(owner)).plan).to.equal("free");
  });
  it("protects a newer subscription update from an older in-flight fetch", async () => {
    await BillingGrant.create({ _id: "sub_owner", owner, scope: `user:${owner}`, planId: "author_monthly", status: "active", until: future() });
    let release; const gate = new Promise(resolve => { release = resolve; }); let started;
    const firstRead = new Promise(resolve => { started = resolve; }); let calls = 0;
    const stripe = { subscriptions: { retrieve: async () => {
      if (++calls === 1) { started(); await gate; return subscription(); }
      return subscription({ status: "canceled" });
    } } };
    const old = syncSubscription("sub_owner", stripe);
    await firstRead;
    await syncSubscription("sub_owner", stripe);
    release(); await old;
    expect((await BillingGrant.findById("sub_owner")).status).to.equal("canceled");
  });
  it("keeps conference admission closed until verified payment", async () => {
    await Conference.create({ conferenceID: "CONF", owners: [owner], status: "pending_payment", startDate: new Date(Date.now() - 1000), endDate: future(), plan: { planID: "conference" } });
    await rejects(assertConferenceAdmission(owner, "repo", "CONF"), "conf_not_activated");
    const value = session(); value.id = "cs_conf"; value.metadata.planId = "conference"; value.metadata.target = "CONF"; value.line_items.data[0].price.id = "price_conf";
    await fulfillCheckout("cs_conf", { checkout: { sessions: { retrieve: async () => value } } });
    expect((await Conference.findOne({ conferenceID: "CONF" })).status).to.equal("ready");
    await assertConferenceAdmission(owner, "repo", "CONF");
    await BillingGrant.updateOne({ _id: "cs_conf" }, { $set: { revoked: true } });
    await rejects(assertConferenceAdmission(owner, "repo", "CONF"), "conference_payment_required");
  });
  it("prevents two simultaneous checkout sessions and reuses an open session", async () => {
    let creates = 0;
    const stripe = { prices: { retrieve: async () => ({ active: true, currency: "eur", unit_amount: 500, recurring: { interval: "month", interval_count: 1 } }) }, subscriptions: { list: async () => ({ data: [] }) }, checkout: { sessions: {
      create: async () => { creates++; await new Promise(r => setTimeout(r, 30)); return { id: "cs_new", url: "https://checkout.stripe.com/test" }; },
      retrieve: async () => ({ id: "cs_new", status: "open", url: "https://checkout.stripe.com/test" }),
    } } };
    const results = await Promise.allSettled([createCheckout(owner, "author_monthly", "", stripe), createCheckout(owner, "author_monthly", "", stripe)]);
    expect(results.filter(r => r.status === "fulfilled")).to.have.length(1);
    await createCheckout(owner, "author_monthly", "", stripe);
    expect(creates).to.equal(1);
  });
  it("revokes only the refunded subscription, including refunds arriving before subscription sync", async () => {
    await BillingGrant.create({ _id: "other-sub", owner, customerId: "cus_owner", subscriptionId: "other-sub", status: "active", until: future() });
    const stripe = { invoicePayments: { list: async () => ({ data: [{ invoice: "in_refunded" }] }) },
      invoices: { retrieve: async () => ({ parent: { subscription_details: { subscription: "sub_refunded" } } }) } };
    await processBillingEvent({ type: "charge.refunded", data: { object: { customer: "cus_owner", payment_intent: "pi_refunded" } } }, stripe);
    expect((await BillingGrant.findById("sub_refunded")).revoked).to.equal(true);
    expect((await BillingGrant.findById("other-sub")).revoked).to.equal(false);
    await syncSubscription("sub_refunded", { subscriptions: { retrieve: async () => subscription({ id: "sub_refunded" }) } });
    expect((await BillingGrant.findById("sub_refunded")).revoked).to.equal(true);
  });

  it("keeps reviewer visits from refreshing snapshots after paid access expires", async () => {
    const Repository = require("../src/core/Repository").default;
    const model = new Repo({ repoId: "frozen", owner, billingManaged: true, status: "ready", lastView: new Date(0), options: { update: true, expirationMode: "never" }, source: { type: "GitHubStream", repositoryName: "owner/repo" } });
    const repo = new Repository(model);
    repo.getToken = () => { throw new Error("Unexpected upstream refresh"); };
    await BillingGrant.create({ _id: "expired-sub", owner, scope: `user:${owner}`, status: "active", until: new Date(0), planId: "author_monthly" });
    await repo.updateIfNeeded();
    expect(repo.status).to.equal("ready");
  });

  it("authenticates billing, checks CSRF, and verifies raw webhook signatures", async () => {
    const express = require("express");
    const sessionMiddleware = require("express-session");
    const Stripe = require("stripe");
    const Users = require("../src/core/model/users/users.model").default;
    const routes = require("../src/server/routes/billing");
    await Users.updateOne({ _id: owner }, { $set: { username: "billing-test-author", status: "active" } }, { upsert: true });
    Object.assign(config, { STRIPE_SECRET_KEY: "sk_test_example", STRIPE_WEBHOOK_SECRET: "whsec_test_example", STRIPE_AUTHOR_MONTHLY_PRICE: "", STRIPE_AUTHOR_ANNUAL_PRICE: "", STRIPE_AUTHOR_PASS_PRICE: "", STRIPE_CONFERENCE_PRICE: "" });
    const app = express();
    app.use("/webhook", routes.billingWebhook);
    app.use(express.json());
    app.use(sessionMiddleware({ secret: "billing-test-session-secret", resave: false, saveUninitialized: false }));
    app.use((req, _res, next) => { req.isAuthenticated = () => req.headers["x-test-auth"] === "yes"; req.user = { user: { _id: owner } }; next(); });
    app.use("/billing", routes.default);
    const server = await new Promise(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      expect((await globalThis.fetch(`${base}/billing`)).status).to.equal(401);
      const get = await globalThis.fetch(`${base}/billing`, { headers: { "x-test-auth": "yes" } });
      const data = await get.json();
      expect(data.csrf).to.be.a("string");
      expect(JSON.stringify(data)).not.to.include("cus_owner");
      const headers = { "x-test-auth": "yes", cookie: get.headers.get("set-cookie").split(";")[0], "content-type": "application/json" };
      expect((await globalThis.fetch(`${base}/billing/checkout`, { method: "POST", headers, body: JSON.stringify({ planId: "arbitrary" }) })).status).to.equal(403);
      expect((await globalThis.fetch(`${base}/billing/draft`, { method: "POST", headers, body: JSON.stringify({ path: "/anonymize", values: { terms: "Private Author" } }) })).status).to.equal(403);
      headers["x-csrf-token"] = data.csrf;
      const saved = await globalThis.fetch(`${base}/billing/draft`, { method: "POST", headers, body: JSON.stringify({ path: "/anonymize", values: { terms: "Private Author" } }) });
      expect(saved.status).to.equal(200);
      const draft = await saved.json();
      expect((await globalThis.fetch(`${base}/billing/draft/${draft.id}`)).status).to.equal(401);
      const restored = await globalThis.fetch(`${base}/billing/draft/${draft.id}`, { headers });
      expect(restored.headers.get("cache-control")).to.equal("no-store");
      expect((await restored.json()).values.terms).to.equal("Private Author");
      await BillingDraft.updateOne({ _id: draft.id }, { owner: "another-owner" });
      expect((await globalThis.fetch(`${base}/billing/draft/${draft.id}`, { headers })).status).to.equal(404);

      const rejected = await globalThis.fetch(`${base}/billing/checkout`, { method: "POST", headers, body: JSON.stringify({ planId: "arbitrary" }) });
      expect((await rejected.json()).error).to.equal("billing_plan_unavailable");
      const payload = JSON.stringify({ id: "evt_test", type: "customer.created", data: { object: { id: "cus_unused" } } });
      const stripe = new Stripe("sk_test_example");
      const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: config.STRIPE_WEBHOOK_SECRET });
      expect((await globalThis.fetch(`${base}/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body: payload })).status).to.equal(200);
      expect((await globalThis.fetch(`${base}/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body: payload + " " })).status).to.equal(400);
      expect((await BillingEvent.findById("test:platform:evt_test")).state).to.equal("pending");
      const originalUpdate = BillingEvent.updateOne;
      BillingEvent.updateOne = async () => { throw new Error("simulated database outage"); };
      try {
        expect((await globalThis.fetch(`${base}/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body: payload })).status).to.equal(500);
      } finally { BillingEvent.updateOne = originalUpdate; }
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await Users.deleteOne({ _id: owner }); }
  });

});
