const { URL } = require("url");
const { expect } = require("chai");
require("ts-node/register/transpile-only");
const mongoose = require("mongoose");
const config = require("../src/config").default;
const { BillingPrice, BillingAccount, BillingGrant, BillingEvent, BillingRevocation, BillingLock, BillingDraft } = require("../src/core/billing/models");
const { receiveBillingEvent, processBillingInbox, billingHealth } = require("../src/core/billing/events");
const { reconcileBillingAccount } = require("../src/core/billing/reconciliation");
const { createCheckout, processBillingEvent } = require("../src/core/billing/stripe");
const { reconcileNeverExpiration, NEVER_EXPIRATION_GRACE_MS } = require("../src/core/billing/expiration");
const Repo = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const uri = process.env.BILLING_TEST_MONGODB_URI;
const owner = "507f1f77bcf86cd799439011";
const { saveBillingDraft, getBillingDraft } = require("../src/core/billing/drafts");
const models = [BillingDraft, BillingPrice, BillingAccount, BillingGrant, BillingEvent, BillingRevocation, BillingLock, Repo];
const iterable = values => ({ async *[Symbol.asyncIterator]() { yield* values; } });
const event = id => ({ id, livemode: false, type: "customer.created", data: { object: { id: "cus_test", email: "private@example.org" } } });
(uri ? describe : describe.skip)("billing failure recovery", function () {
  this.timeout(20000);
  const original = { ...config };
  before(async () => {
    if (!/^billing_test_/.test(new URL(uri).pathname.slice(1))) throw new Error("Disposable database required");
    await mongoose.connect(uri);
    await Promise.all(models.map(m => m.init()));
  });
  beforeEach(async () => {
    await Promise.all(models.map(m => m.deleteMany({})));
    Object.assign(config, { BILLING_ENABLED: true, BILLING_CHECKOUT_ENABLED: true, STRIPE_AUTHOR_MONTHLY_PRICE: "price_monthly" });
    await BillingAccount.create({ _id: owner, customerId: "cus_owner" });
  });
  after(async () => { Object.assign(config, original); await mongoose.disconnect(); });
  it("deduplicates concurrent receipt without retaining customer data", async () => {
    await Promise.all(Array.from({ length: 8 }, () => receiveBillingEvent(event("evt_one"))));
    expect(await BillingEvent.countDocuments()).to.equal(1);
    expect(JSON.stringify(await BillingEvent.findOne())).not.to.include("private@example.org");
    let calls = 0;
    await Promise.all([processBillingInbox(1, async () => { calls++; }), processBillingInbox(1, async () => { calls++; })]);
    expect(calls).to.equal(1);
    expect((await BillingEvent.findOne()).state).to.equal("complete");
  });
  it("recovers a crash after side effects but before acknowledgement", async () => {
    await receiveBillingEvent(event("evt_crash"));
    await BillingGrant.create({ _id: "already-applied", status: "paid" });
    await BillingEvent.updateOne({}, { $set: { state: "processing", token: "dead-worker", leaseUntil: new Date(0) } });
    await processBillingInbox(1, async () => {
      await BillingGrant.updateOne({ _id: "already-applied" }, { $setOnInsert: { status: "paid" } }, { upsert: true });
    });
    expect(await BillingGrant.countDocuments()).to.equal(1);
    expect((await BillingEvent.findOne()).state).to.equal("complete");
  });
  it("backs off failures, redacts errors and exposes exhausted retries", async () => {
    await receiveBillingEvent(event("evt_fail"));
    await processBillingInbox(1, async () => { throw new Error("secret payload"); });
    let record = await BillingEvent.findOne();
    expect(record.state).to.equal("pending");
    expect(record.nextAttemptAt.getTime()).to.be.greaterThan(record.receivedAt.getTime());
    expect(record.lastError).not.to.include("secret");
    await BillingEvent.updateOne({}, { $set: { attempts: 11, nextAttemptAt: new Date(0) } });
    await processBillingInbox(1, async () => { throw new Error("secret"); });
    record = await BillingEvent.findOne();
    expect(record.state).to.equal("failed");
    expect((await billingHealth()).failed).to.equal(1);
  });
  it("recovers missing grants from provider history and applies missed refunds", async () => {
    const sub = { id: "sub_lost", metadata: { application: "anonymous-github", owner }, customer: "cus_owner", status: "active",
      latest_invoice: { status: "paid" }, items: { data: [{ price: { id: "price_monthly" }, current_period_end: Math.floor(Date.now() / 1000) + 86400 }] } };
    const stripe = { subscriptions: { list: () => iterable([sub]), retrieve: async () => sub },
      checkout: { sessions: { list: () => iterable([]) } },
      charges: { list: () => iterable([{ id: "ch_refunded", refunded: true, payment_intent: "pi_refunded" }]) },
      invoicePayments: { list: async () => ({ data: [{ invoice: "in_refunded" }] }) },
      invoices: { retrieve: async () => ({ parent: { subscription_details: { subscription: "sub_lost" } } }) } };
    await reconcileBillingAccount(owner, stripe);
    expect((await BillingGrant.findById("sub_lost")).revoked).to.equal(true);
    expect((await BillingAccount.findById(owner)).reconciledAt).to.be.instanceOf(Date);
    // A restored database with no grants can reconstruct the same final state.
    await BillingGrant.deleteMany({});
    await reconcileBillingAccount(owner, stripe);
    expect((await BillingGrant.findById("sub_lost")).revoked).to.equal(true);
  });
  it("recovers paid time when the latest invoice failed after a missed renewal", async () => {
    const { syncSubscription } = require("../src/core/billing/stripe");
    const end = Math.floor(Date.now() / 1000);
    await syncSubscription("sub_history", {
      subscriptions: { retrieve: async () => ({ id: "sub_history", customer: "cus_owner", metadata: { application: "anonymous-github", owner },
        status: "past_due", latest_invoice: { status: "open" }, items: { data: [{ id: "si_owned", price: { id: "price_monthly" }, current_period_end: end + 86400 }] } }) },
      invoices: { list: () => iterable([{ id: "in_paid" }]), listLineItems: () => iterable([
        { amount: 500, parent: { subscription_item_details: { subscription_item: "si_owned" } }, period: { end } },
        { amount: 500, parent: { subscription_item_details: { subscription_item: "si_unrelated" } }, period: { end: end + 999999 } },
      ]) },
    });
    expect((await BillingGrant.findById("sub_history")).until.getTime()).to.equal(end * 1000);
  });
  it("preserves a refund received before the first grant exists", async () => {
    const { fulfillCheckout } = require("../src/core/billing/stripe");
    config.STRIPE_AUTHOR_PASS_PRICE = "price_pass";
    const stripe = { invoicePayments: { list: async () => ({ data: [] }) }, checkout: { sessions: { retrieve: async () => ({
      id: "cs_late", status: "complete", payment_status: "paid", customer: "cus_owner", created: Math.floor(Date.now() / 1000),
      metadata: { application: "anonymous-github", owner, planId: "author_pass", target: "repo" },
      line_items: { data: [{ price: { id: "price_pass" }, quantity: 1 }] },
      payment_intent: { id: "pi_early", latest_charge: { refunded: false, disputed: false } },
    }) } } };
    await processBillingEvent({ type: "charge.refunded", data: { object: { payment_intent: "pi_early", refunded: true } } }, stripe);
    await fulfillCheckout("cs_late", stripe);
    expect((await BillingGrant.findById("cs_late")).revoked).to.equal(true);
  });
  it("starts a fresh attempt only after the old immutable request cannot execute", async () => {
    await BillingAccount.updateOne({ _id: owner }, { $set: { checkout: {
      key: "old", planId: "author_monthly", target: "", createdAt: new Date(0), params: { expires_at: 1000 },
    } } });
    const stripe = checkoutStripe();
    stripe.checkout.sessions.create = async (_params, options) => {
      expect(options.idempotencyKey).not.to.equal("old");
      return { id: "cs_fresh", url: "https://checkout.stripe.com/fresh" };
    };
    expect(await createCheckout(owner, "author_monthly", "", stripe)).to.equal("https://checkout.stripe.com/fresh");
  });
  it("keeps partial refunds active and revokes a full refund", async () => {
    await BillingGrant.create({ _id: "pass", paymentIntentId: "pi_pass", status: "paid" });
    const stripe = { invoicePayments: { list: async () => ({ data: [] }) } };
    const refund = refunded => ({ type: "charge.refunded", data: { object: { payment_intent: "pi_pass", refunded } } });
    await processBillingEvent(refund(false), stripe);
    expect((await BillingGrant.findById("pass")).revoked).to.equal(false);
    await processBillingEvent(refund(true), stripe);
    expect((await BillingGrant.findById("pass")).revocationReason).to.equal("full_refund");
  });
  it("requires review for a new dispute but ignores an older refund replay after review", async () => {
    await BillingGrant.create({ _id: "reviewed-pass", paymentIntentId: "pi_reviewed", status: "paid" });
    const stripe = { invoicePayments: { list: async () => ({ data: [] }) }, charges: { retrieve: async () => ({ payment_intent: "pi_reviewed", disputed: true }) } };
    const refund = { type: "charge.refunded", data: { object: { payment_intent: "pi_reviewed", refunded: true } } };
    await processBillingEvent(refund, stripe);
    await BillingRevocation.updateOne({ _id: "pi_reviewed" }, { $set: { reviewed: true } });
    await BillingGrant.updateOne({ _id: "reviewed-pass" }, { $set: { revoked: false } });
    await processBillingEvent({ type: "charge.dispute.created", data: { object: { charge: "ch_reviewed" } } }, stripe);
    expect((await BillingGrant.findById("reviewed-pass")).revoked).to.equal(true);
    await BillingRevocation.updateOne({ _id: "pi_reviewed" }, { $set: { reviewed: true } });
    await BillingGrant.updateOne({ _id: "reviewed-pass" }, { $set: { revoked: false } });
    await processBillingEvent(refund, stripe);
    expect((await BillingGrant.findById("reviewed-pass")).revoked).to.equal(false);
  });
  it("defers expiration during outage and discovers a renewal before removing content", async () => {
    const deadline = new Date(Date.now() - 1000);
    await Repo.create({ repoId: "protected", owner, status: "ready", options: { expirationMode: "never" }, billingNeverExpiresUntil: deadline });
    await reconcileNeverExpiration(new Date(), async () => { throw new Error("Stripe unavailable"); });
    expect((await Repo.findOne()).options.expirationMode).to.equal("never");
    const until = new Date(Date.now() + 86400_000);
    await reconcileNeverExpiration(new Date(), async () => {
      await BillingGrant.create({ _id: "renewal", owner, scope: `user:${owner}`, planId: "author_monthly", until, status: "active" });
    });
    const repo = await Repo.findOne();
    expect(repo.options.expirationMode).to.equal("never");
    expect(repo.billingNeverExpiresUntil.getTime()).to.equal(until.getTime() + NEVER_EXPIRATION_GRACE_MS);
  });
  function checkoutStripe() {
    return { prices: { retrieve: async () => ({ active: true, currency: "eur", unit_amount: 500, recurring: { interval: "month", interval_count: 1 } }) },
      subscriptions: { list: async () => ({ data: [] }) }, checkout: { sessions: {
        create: async () => { throw new Error("connection lost"); },
        list: () => iterable([]),
        retrieve: async () => ({ status: "open", url: "https://checkout.stripe.com/recovered" }),
      } } };
  }
  it("records an accepted one-time price before an uncertain checkout response", async () => {
    config.STRIPE_AUTHOR_PASS_PRICE = "price_retiring";
    await Repo.create({ repoId: "pass-target", owner, status: "ready" });
    const stripe = checkoutStripe();
    stripe.prices.retrieve = async () => ({ active: true, currency: "eur", unit_amount: 1500 });
    try { await createCheckout(owner, "author_pass", "pass-target", stripe); throw Error("expected network failure"); }
    catch (error) { expect(error.message).to.equal("connection lost"); }
    expect((await BillingPrice.findById("price_retiring")).planId).to.equal("author_pass");
    config.STRIPE_AUTHOR_PASS_PRICE = "";
    const { fulfillCheckout } = require("../src/core/billing/stripe");
    stripe.checkout.sessions.retrieve = async () => ({ id: "cs_retired", status: "complete", payment_status: "paid", customer: "cus_owner",
      created: Math.floor(Date.now() / 1000), metadata: { application: "anonymous-github", owner, planId: "author_pass", target: "pass-target" },
      line_items: { data: [{ price: { id: "price_retiring" }, quantity: 1 }] }, payment_intent: null });
    await fulfillCheckout("cs_retired", stripe);
    expect((await BillingGrant.findById("cs_retired")).status).to.equal("paid");
  });
  it("keeps checkout drafts private, bounded and expired even before the TTL sweep", async () => {
    const draft = await saveBillingDraft(owner, "/anonymize", { terms: "Private Author", options: { expirationMode: "never" }, customerId: "untrusted" });
    expect((await getBillingDraft(owner, draft.id)).values).not.to.have.property("customerId");
    for (const other of ["someone-else", owner]) {
      if (other === owner) await BillingDraft.updateOne({ _id: draft.id }, { expiresAt: new Date(0) });
      try { await getBillingDraft(other, draft.id); throw new Error("expected rejection"); }
      catch (error) { expect(error.message).to.equal("billing_draft_not_found"); }
    }
    for (const path of ["//evil.example", "/anonymize?next=https://evil.example", "/anonymize/../profile"]) {
      try { await saveBillingDraft(owner, path, {}); throw new Error("expected rejection"); }
      catch (error) { expect(error.message).to.equal("billing_invalid_draft"); }
    }
    try { await saveBillingDraft(owner, "/anonymize", { terms: "x".repeat(65537) }); throw new Error("expected rejection"); }
    catch (error) { expect(error.message).to.equal("billing_invalid_draft"); }
  });
  it("returns checkout to the saved task and refuses reuse for a different task", async () => {
    const stripe = checkoutStripe();
    const draft = await saveBillingDraft(owner, "/anonymize", { terms: "Author" });
    const destination = `/anonymize?billingDraft=${draft.id}`;
    let parameters;
    stripe.checkout.sessions.create = async params => { parameters = params; return { id: "cs_task", url: "https://checkout.stripe.com/task" }; };
    await createCheckout(owner, "author_monthly", "", stripe, destination);
    expect(parameters.success_url).to.include(destination + "&billing=success");
    expect(parameters.cancel_url).to.include(destination + "&billing=cancelled");
    await createCheckout(owner, "author_monthly", "", stripe, destination);
    try { await createCheckout(owner, "author_monthly", "", stripe); throw new Error("expected rejection"); }
    catch (error) { expect(error.message).to.equal("billing_checkout_in_progress"); }
    try { await createCheckout(owner, "author_monthly", "", stripe, "https://evil.example"); throw new Error("expected rejection"); }
    catch (error) { expect(error.message).to.equal("billing_invalid_draft"); }
  });
  it("retries a lost response with identical parameters and the same key", async () => {
    const stripe = checkoutStripe();
    let first;
    stripe.checkout.sessions.create = async (params, options) => { first = { params, options }; throw new Error("connection lost"); };
    try { await createCheckout(owner, "author_monthly", "", stripe); } catch (e) { expect(e.message).to.equal("connection lost"); }
    const saved = await BillingAccount.findById(owner);
    expect(saved.checkout.id).to.equal(undefined);
    stripe.checkout.sessions.create = async (params, options) => {
      expect(params).to.deep.equal(first.params);
      expect(options).to.deep.equal(first.options);
      return { id: "cs_recovered", url: "https://checkout.stripe.com/recovered" };
    };
    await createCheckout(owner, "author_monthly", "", stripe);
    expect((await BillingAccount.findById(owner)).checkout.id).to.equal("cs_recovered");
  });
  it("recovers an old attempt by metadata without creating another payment", async () => {
    await BillingAccount.updateOne({ _id: owner }, { $set: { checkout: { key: "attempt", planId: "author_monthly", target: "", createdAt: new Date(0) } } });
    const stripe = checkoutStripe();
    stripe.checkout.sessions.list = () => iterable([{ id: "cs_recovered", metadata: { attempt: "attempt", owner } }]);
    expect(await createCheckout(owner, "author_monthly", "", stripe)).to.equal("https://checkout.stripe.com/recovered");
  });
  it("blocks unresolved old requests instead of reusing a pruned key", async () => {
    await BillingAccount.updateOne({ _id: owner }, { $set: { checkout: { key: "old", planId: "author_monthly", target: "", createdAt: new Date(0) } } });
    try { await createCheckout(owner, "author_monthly", "", checkoutStripe()); throw new Error("expected rejection"); }
    catch (e) { expect(e.message).to.equal("billing_recovery_required"); }
  });
  it("checks subsequent subscription pages before offering another subscription", async () => {
    const stripe = checkoutStripe();
    stripe.subscriptions.list = async ({ starting_after }) => starting_after
      ? { data: [{ id: "active", status: "active" }], has_more: false }
      : { data: [{ id: "old", status: "canceled" }], has_more: true };
    try { await createCheckout(owner, "author_monthly", "", stripe); throw new Error("expected rejection"); }
    catch (e) { expect(e.message).to.equal("billing_subscription_exists"); }
  });
  it("stops new purchases independently of event processing", async () => {
    config.BILLING_CHECKOUT_ENABLED = false;
    try { await createCheckout(owner, "author_monthly", "", checkoutStripe()); throw new Error("expected rejection"); }
    catch (e) { expect(e.message).to.equal("billing_checkout_disabled"); }
    await receiveBillingEvent(event("evt_existing"));
    await processBillingInbox(1, async () => {});
    expect((await BillingEvent.findOne()).state).to.equal("complete");
  });
});
