const { URL } = require("node:url");
const { setTimeout } = require("node:timers");
const { expect } = require("chai");
require("ts-node/register/transpile-only");
const mongoose = require("mongoose");
const config = require("../src/config").default;
const { BillingPrice, BillingAccount, BillingGrant, BillingQuota, BillingLock, BillingEvent, BillingRevocation, BillingDraft } = require("../src/core/billing/models");
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
    await Promise.all([BillingPrice, BillingAccount, BillingGrant, BillingQuota, BillingLock, BillingEvent, BillingRevocation, BillingDraft, Repo, Conference].map(m => m.init()));
  });
  beforeEach(async () => {
    Object.assign(config, { BILLING_ENABLED: true, FREE_AUTHOR_REPOSITORIES: 3, FREE_AUTHOR_STORAGE: 100,
      PAID_AUTHOR_STORAGE: 1000, PAID_AUTHOR_REPOSITORIES: 20, STRIPE_AUTHOR_MONTHLY_PRICE: "price_monthly", STRIPE_AUTHOR_PASS_PRICE: "price_pass", STRIPE_CONFERENCE_PRICE: "price_conf", STRIPE_CONFERENCE_SMALL_PRICE: "price_conf_small", STRIPE_CONFERENCE_LARGE_PRICE: "price_conf_large", PAID_CONFERENCE_SMALL_REPOSITORIES: 25, STRIPE_REPO_EXTEND_PRICE: "", STRIPE_REPO_NEVER_PRICE: "", STRIPE_REPO_SLOT_PRICE: "", STRIPE_REPO_PACK_PRICE: "" });
    Object.assign(config, { STRIPE_AUTHOR_ANNUAL_PRICE: "price_annual", STRIPE_LEGACY_PRICES: "" });
    await Promise.all([BillingPrice, BillingAccount, BillingGrant, BillingQuota, BillingLock, BillingEvent, BillingRevocation, BillingDraft, Repo, Conference].map(m => m.deleteMany({})));
    await BillingAccount.create({ _id: owner, customerId: "cus_owner" });
  });
  after(async () => { Object.assign(config, original); await mongoose.disconnect(); });
  it("indexes terminal quota lookups by repository ID rather than scanning removed repositories", async () => {
    await Repo.insertMany(Array.from({ length: 1000 }, (_, i) => ({ repoId: `removed-${i}`, owner, status: "removed" })));
    await BillingQuota.create({ _id: `user:${owner}`, allocations: [{ repoId: "removed-999", reservationId: "old", bytes: 90 }] });
    const find = Repo.find; let terminalQuery;
    Repo.find = function (...args) {
      const query = find.apply(this, args);
      if (args[0]?.repoId?.$in) terminalQuery = query;
      return query;
    };
    try {
      await reserveRepository(owner, "new", 100);
      expect((await BillingQuota.findById(`user:${owner}`)).allocations.map(a => a.repoId)).to.deep.equal(["new"]);
      const plan = await terminalQuery.clone().explain("executionStats");
      expect(plan.executionStats.totalDocsExamined).to.equal(1);
      expect(plan.executionStats.totalKeysExamined).to.equal(1);
    } finally { Repo.find = find; }
  });
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
  it("does not seed personal capacity with conference-funded or pass-funded repositories", async () => {
    await BillingGrant.create([
      { _id: "conf-grant", owner, scope: "conference:funded", status: "paid", until: future(), planId: "conference" },
      { _id: "pass-grant", owner, scope: "repo:pass", status: "paid", until: future(), planId: "author_pass" },
    ]);
    await Repo.create([...["a", "b", "c"].map(repoId => ({ repoId, owner, conference: "funded", status: "ready", size: { storage: 80 } })),
      { repoId: "pass", owner, status: "ready", size: { storage: 80 } }]);
    await reserveRepository(owner, "personal", 10);
    const ledger = await BillingQuota.findById(`user:${owner}`);
    expect(ledger.allocations.map(a => a.repoId)).to.deep.equal(["personal"]);
  });
  it("accounts for concurrent resolved-file growth without double charging retries", async () => {
    const { reserveFileExpansion } = require("../src/core/billing/quotas");
    await Repo.create({ repoId: "lfs", owner, billingManaged: true, status: "ready", size: { storage: 10 } });
    await reserveRepository(owner, "lfs", 10);
    await Promise.all(Array.from({ length: 8 }, () => reserveFileExpansion("lfs", "file-a", 40)));
    expect((await BillingQuota.findById(`user:${owner}`)).allocations[0].bytes).to.equal(50);
    await reserveFileExpansion("lfs", "file-b", 40);
    await rejects(reserveFileExpansion("lfs", "file-c", 20), "quota_exceeded");
    await reserveRepository(owner, "lfs", 15);
    expect((await BillingQuota.findById(`user:${owner}`)).allocations[0].bytes).to.equal(95);
    await reserveFileExpansion("lfs", "file-a", 1);
    expect((await BillingQuota.findById(`user:${owner}`)).allocations[0].bytes).to.equal(95);
  });
  it("shows only personally funded repositories before a user ledger exists", async () => {
    const utils = require("../src/server/routes/route-utils");
    const originalUser = utils.getUser;
    await BillingGrant.create({ _id: "conf-usage", owner, scope: "conference:funded", status: "paid", until: future(), planId: "conference" });
    utils.getUser = async () => ({ id: owner, quotaRepositories: async () => [
      { repoId: "conference-work", conference: "funded", size: { storage: 90, file: 1 } },
      { repoId: "personal-work", size: { storage: 10, file: 1 } },
    ] });
    try {
      const router = require("../src/server/routes/user").default;
      const handler = router.stack.find(layer => layer.route?.path === "/quota").route.stack[0].handle;
      let body;
      await handler({}, { json: value => { body = value; } });
      expect(body.repository.used).to.equal(1);
      expect(body.storage.used).to.equal(10);
      expect(body.file.used).to.equal(1);
    } finally { utils.getUser = originalUser; }
  });
  for (const replacement of [true, false]) {
    it(`retains a reservation during retirement and ${replacement ? "replacement" : "releases it after permanent removal"}`, async () => {
      const Repository = require("../src/core/Repository").default;
      const db = require("../src/server/database");
      const wasConnected = db.isConnected;
      config.FREE_AUTHOR_REPOSITORIES = 1;
      const model = await Repo.create({ repoId: "published", owner, billingManaged: true, status: "ready", size: { storage: 10 } });
      await reserveRepository(owner, "published", 20);
      const repo = new Repository(model);
      repo.resetSate = async () => {
        expect((await Repo.findOne({ repoId: "published" })).status).to.equal("removing");
        await rejects(reserveRepository(owner, "competitor", 1), "quota_exceeded");
      };
      db.isConnected = true;
      try { await repo.remove({ replacement }); }
      finally { db.isConnected = wasConnected; }
      expect((await Repo.findOne({ repoId: "published" })).status).to.equal(replacement ? "preparing" : "removed");
      if (replacement) {
        await rejects(reserveRepository(owner, "competitor", 1), "quota_exceeded");
        expect((await BillingQuota.findById(`user:${owner}`)).allocations[0].bytes).to.equal(20);
      } else await reserveRepository(owner, "competitor", 1);
    });
  }
  for (const fails of [false, true]) {
    it(`claims removed restoration before admission and ${fails ? "recovers a failed admission" : "protects it from a competitor"}`, async () => {
      const Repository = require("../src/core/Repository").default;
      const utils = require("../src/server/routes/route-utils");
      const quotas = require("../src/core/billing/quotas");
      const queue = require("../src/queue");
      const saved = { getRepo: utils.getRepo, getUser: utils.getUser, handleError: utils.handleError, reserve: quotas.reserveRepository, queue: queue.downloadQueue };
      config.FREE_AUTHOR_REPOSITORIES = 1;
      const model = await Repo.create({ repoId: "restore", owner, billingManaged: true, status: "removed", statusDate: new Date(0),
        source: { type: "GitHubStream", repositoryName: "owner/repo", commit: "abc123", branch: "main" }, size: { storage: 10 } });
      utils.getRepo = async () => new Repository(model);
      utils.getUser = async () => ({ isAdmin: true });
      utils.handleError = error => { throw error; };
      let queued = false;
      queue.downloadQueue = { add: async () => { queued = true; } };
      quotas.reserveRepository = async (...args) => {
        expect((await Repo.findById(model._id)).status).to.equal("preparing");
        if (fails) throw Error("quota_exceeded");
        await saved.reserve(...args);
        await rejects(saved.reserve(owner, "competitor", 1), "quota_exceeded");
      };
      try {
        const router = require("../src/server/routes/repository-private").default;
        const handler = router.stack.find(layer => layer.route?.path === "/:repoId/" && layer.route.methods.post).route.stack[0].handle;
        const work = handler({ body: { repoId: "restore", fullName: "owner/repo", source: { commit: "abc123", branch: "main" }, terms: [],
          options: { expirationMode: "remove", expirationDate: future() } } }, { json() {} });
        if (fails) await rejects(work, "quota_exceeded"); else await work;
        expect(queued).to.equal(!fails);
        expect((await Repo.findById(model._id)).status).to.equal(fails ? "removed" : "preparing");
      } finally {
        utils.getRepo = saved.getRepo; utils.getUser = saved.getUser; utils.handleError = saved.handleError;
        quotas.reserveRepository = saved.reserve; queue.downloadQueue = saved.queue;
      }
    });
  }
  it("does not let stale removal cleanup delete a fresh reservation", async () => {
    config.FREE_AUTHOR_REPOSITORIES = 1;
    await Repo.create({ repoId: "restoring", owner, status: "ready", size: { storage: 10 } });
    await reserveRepository(owner, "restoring", 10);
    await Repo.updateOne({ repoId: "restoring" }, { $set: { status: "removed" } });
    const update = BillingQuota.updateOne;
    let interleaved = false;
    BillingQuota.updateOne = async function (...args) {
      if (args[1].$pull && !interleaved) {
        interleaved = true;
        await Repo.updateOne({ repoId: "restoring" }, { $set: { status: "preparing" } });
        await reserveRepository(owner, "restoring", 20);
      }
      return update.apply(this, args);
    };
    try { await rejects(reserveRepository(owner, "competitor", 1), "quota_exceeded"); }
    finally { BillingQuota.updateOne = update; }
    expect(interleaved).to.equal(true);
    expect((await BillingQuota.findById(`user:${owner}`)).allocations[0].bytes).to.equal(20);
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
  function addonSession(id, planId, created = Math.floor(Date.now() / 1000)) {
    return { id, metadata: { application: "anonymous-github", owner, planId, target: "repo" },
      customer: "cus_owner", status: "complete", payment_status: "paid", created,
      line_items: { data: [{ price: { id: `price_${planId}` }, quantity: 1 }] }, payment_intent: { id: `pi_${id}`, latest_charge: { amount_refunded: 0, disputed: false } } };
  }
  function sessionsStripe(sessions) {
    return { checkout: { sessions: { retrieve: async id => sessions.find(s => s.id === id) } } };
  }
  it("stacks extended expiration purchases and records never expire once", async () => {
    Object.assign(config, { STRIPE_REPO_EXTEND_PRICE: "price_repo_extend", STRIPE_REPO_NEVER_PRICE: "price_repo_never" });
    const year = 365 * 86400000;
    const first = addonSession("cs_extend_1", "repo_extend");
    const second = addonSession("cs_extend_2", "repo_extend", first.created + 60);
    const never = addonSession("cs_never", "repo_never");
    const stripe = sessionsStripe([first, second, never]);
    await fulfillCheckout(first.id, stripe);
    await fulfillCheckout(second.id, stripe);
    // A duplicate delivery must not add another year.
    await fulfillCheckout(second.id, stripe);
    expect((await BillingGrant.findById(first.id)).until.getTime()).to.equal(first.created * 1000 + year);
    expect((await BillingGrant.findById(second.id)).until.getTime()).to.equal(first.created * 1000 + 2 * year);
    await fulfillCheckout(never.id, stripe);
    expect((await BillingGrant.findById(never.id)).until.toISOString()).to.equal("9999-12-31T00:00:00.000Z");
  });
  it("hosts an extra repository outside the free allowance for its buyer only", async () => {
    config.STRIPE_REPO_SLOT_PRICE = "price_repo_slot";
    await Promise.all(["a", "b", "repo"].map(id => reserveRepository(owner, id, 10)));
    await rejects(reserveRepository(owner, "four", 10), "quota_exceeded");
    // Buying a slot for a counted repository frees its place in the free ledger.
    const slot = addonSession("cs_slot", "repo_slot");
    await fulfillCheckout(slot.id, sessionsStripe([slot]));
    expect((await BillingGrant.findById(slot.id)).until.toISOString()).to.equal("9999-12-31T00:00:00.000Z");
    expect((await BillingQuota.findById(`user:${owner}`)).allocations.map(a => a.repoId)).to.not.include("repo");
    expect((await allowance(owner, "repo")).plan).to.equal("repo_slot");
    await reserveRepository(owner, "repo", 10);
    await reserveRepository(owner, "four", 10);
    // Another account cannot use a slot bought for the same repository ID.
    expect((await allowance("507f1f77bcf86cd799439099", "repo")).plan).to.equal("free");
    config.STRIPE_REPO_SLOT_PRICE = "";
  });
  it("fulfills a paper pack as three add-ons that a refund revokes together", async () => {
    config.STRIPE_REPO_PACK_PRICE = "price_repo_pack";
    const pack = addonSession("cs_pack", "repo_pack");
    const stripe = sessionsStripe([pack]);
    await fulfillCheckout(pack.id, stripe);
    await fulfillCheckout(pack.id, stripe);
    const grants = await BillingGrant.find({ paymentIntentId: "pi_cs_pack" }).lean();
    expect(grants.map(g => g.planId).sort()).to.deep.equal(["author_pass", "repo_extend", "repo_slot"]);
    expect(grants.find(g => g.planId === "repo_extend").until.getTime()).to.equal(pack.created * 1000 + 365 * 86400000);
    // Live updates win over the manual-refresh slot while both fund the repository.
    expect((await allowance(owner, "repo")).plan).to.equal("author_pass");
    await processBillingEvent({ type: "charge.refunded", data: { object: { payment_intent: "pi_cs_pack", refunded: true } } },
      { ...stripe, invoicePayments: { list: async () => ({ data: [] }) } });
    expect(await BillingGrant.countDocuments({ paymentIntentId: "pi_cs_pack", revoked: true })).to.equal(3);
    expect((await allowance(owner, "repo")).plan).to.equal("free");
    config.STRIPE_REPO_PACK_PRICE = "";
  });
  it("does not let expiration add-ons replace the storage allowance", async () => {
    await BillingGrant.create([{ _id: "extend", owner, scope: "repo:repo", status: "paid", until: future(), planId: "repo_extend" },
      { _id: "never", owner, scope: "repo:repo", status: "paid", until: future(), planId: "repo_never" }]);
    expect((await allowance(owner, "repo")).plan).to.equal("free");
    await BillingGrant.create({ _id: "pass", owner, scope: "repo:repo", status: "paid", until: future(), planId: "author_pass" });
    expect((await allowance(owner, "repo")).plan).to.equal("author_pass");
  });
  it("limits dated expiration by free window, add-on, subscription and conference", async () => {
    const { maximumExpiration } = require("../src/core/billing/expiration");
    const now = new Date("2026-01-10T12:00:00Z");
    const months = (date, n) => { const d = new Date(date); d.setMonth(d.getMonth() + n); d.setHours(23, 59, 59, 999); return d.getTime(); };
    expect((await maximumExpiration(owner, "repo", undefined, now)).getTime()).to.equal(months(now, 5));
    const extended = new Date("2027-06-01T00:00:00Z");
    await BillingGrant.create({ _id: "extend", owner, scope: "repo:repo", status: "paid", until: extended, planId: "repo_extend" });
    const withAddon = await maximumExpiration(owner, "repo", undefined, now);
    expect(withAddon.getTime()).to.be.greaterThan(extended.getTime() - 86400000);
    expect((await maximumExpiration(owner, "other", undefined, now)).getTime()).to.equal(months(now, 5));
    await BillingGrant.updateOne({ _id: "extend" }, { $set: { revoked: true } });
    expect((await maximumExpiration(owner, "repo", undefined, now)).getTime()).to.equal(months(now, 5));
    await Conference.create({ conferenceID: "LONG", owners: [owner], status: "ready", startDate: now, endDate: new Date("2026-09-01T00:00:00Z"), plan: { planID: "conference" } });
    expect((await maximumExpiration(owner, "repo", "LONG", now)).toISOString()).to.equal("2026-09-01T00:00:00.000Z");
    await BillingGrant.create({ _id: "sub", owner, scope: `user:${owner}`, status: "active", until: new Date("2026-02-10T00:00:00Z"), planId: "author_monthly" });
    expect((await maximumExpiration(owner, "repo", undefined, now)).getTime()).to.equal(months(now, 12));
  });
  it("lets a Never expire add-on keep one repository online until it is revoked", async () => {
    const { neverExpirationDeadline, reconcileNeverExpiration, NEVER_EXPIRATION_GRACE_MS } = require("../src/core/billing/expiration");
    await rejects(neverExpirationDeadline(owner, undefined, "repo"), "subscription_required_for_never_expiration");
    await BillingGrant.create({ _id: "never", owner, scope: "repo:repo", status: "paid", until: new Date("9999-12-31T00:00:00Z"), planId: "repo_never" });
    const before = Date.now();
    const deadline = await neverExpirationDeadline(owner, undefined, "repo");
    expect(deadline.getTime()).to.be.at.least(before + NEVER_EXPIRATION_GRACE_MS);
    await rejects(neverExpirationDeadline(owner, undefined, "other"), "subscription_required_for_never_expiration");
    await Repo.create({ repoId: "repo", owner, status: "ready", options: { expirationMode: "never" }, billingNeverExpiresUntil: new Date(Date.now() + 86400000) });
    // A valid add-on rolls a close deadline forward to the full grace period.
    await reconcileNeverExpiration();
    const rolled = (await Repo.findOne({ repoId: "repo" })).billingNeverExpiresUntil.getTime();
    expect(rolled).to.be.at.least(before + NEVER_EXPIRATION_GRACE_MS);
    // A recent deadline is not rewritten on every run.
    await reconcileNeverExpiration(new Date(Date.now() + 86400000));
    expect((await Repo.findOne({ repoId: "repo" })).billingNeverExpiresUntil.getTime()).to.equal(rolled);
    // After a refund the deadline stops moving and the repository expires.
    await BillingGrant.updateOne({ _id: "never" }, { $set: { revoked: true } });
    await reconcileNeverExpiration(new Date(rolled), async () => {});
    expect((await Repo.findOne({ repoId: "repo" })).options.expirationMode).to.equal("remove");
  });
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
  it("reconciles retired one-time prices and continues refund recovery", async () => {
    const { reconcileBillingAccount } = require("../src/core/billing/reconciliation");
    const iterable = values => ({ async *[Symbol.asyncIterator]() { yield* values; } });
    const value = session();
    const stripe = { checkout: { sessions: { retrieve: async () => value, list: () => iterable([value]) } },
      subscriptions: { list: () => iterable([]) }, charges: { list: () => iterable([{ payment_intent: "pi_pass", refunded: true }]) },
      invoicePayments: { list: async () => ({ data: [] }) } };
    await fulfillCheckout(value.id, stripe);
    config.STRIPE_AUTHOR_PASS_PRICE = "";
    await BillingGrant.deleteMany({});
    await reconcileBillingAccount(owner, stripe);
    expect((await BillingGrant.findById(value.id)).revoked).to.equal(true);
    expect((await BillingAccount.findById(owner)).reconciledAt).to.be.instanceOf(Date);
    value.line_items.data[0].price.id = "price_unrecognized";
    await rejects(fulfillCheckout(value.id, stripe), "billing_invalid_purchase");
  });
  it("preserves previously accepted grants without historical price fields", async () => {
    const value = session();
    await BillingGrant.create({ _id: value.id, owner, customerId: "cus_owner", scope: "repo:repo", planId: "author_pass", status: "paid" });
    config.STRIPE_AUTHOR_PASS_PRICE = "";
    await fulfillCheckout(value.id, { checkout: { sessions: { retrieve: async () => value } } });
    expect((await BillingPrice.findById("price_pass")).planId).to.equal("author_pass");
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
  it("activates a smaller conference package with its own capacity and only for its tier", async () => {
    await Conference.create({ conferenceID: "WS", owners: [owner], status: "pending_payment", startDate: new Date(Date.now() - 1000), endDate: future(), plan: { planID: "conference_workshop" } });
    await rejects(createCheckout(owner, "conference_large", "WS", {}), "billing_invalid_conference");
    const value = session(); value.id = "cs_ws"; value.metadata.planId = "conference_workshop"; value.metadata.target = "WS"; value.line_items.data[0].price.id = "price_conf_small";
    await fulfillCheckout("cs_ws", { checkout: { sessions: { retrieve: async () => value } } });
    expect((await Conference.findOne({ conferenceID: "WS" })).status).to.equal("ready");
    const limits = await allowance(owner, "repo", "WS");
    expect(limits.scope).to.equal("conference:WS");
    expect(limits.plan).to.equal("conference_workshop");
    expect(limits.repositories).to.equal(25);
    await assertConferenceAdmission(owner, "repo", "WS");
  });
  it("keeps legacy and new annual subscriptions after the annual price is replaced", async () => {
    const { rememberConfiguredPrices } = require("../src/core/billing/stripe");
    // Deployed before the switch: the old annual price is recorded at startup.
    await rememberConfiguredPrices();
    const annual = (id, price) => subscription({ id, items: { data: [{ price: { id: price }, current_period_end: Math.floor(future().getTime() / 1000) }] } });
    let legacy = annual("sub_owner", "price_annual");
    const stripe = { subscriptions: { retrieve: async id => id === "sub_owner" ? legacy : annual(id, "price_annual_new") } };
    config.STRIPE_AUTHOR_ANNUAL_PRICE = "price_annual_new";
    await syncSubscription("sub_owner", stripe);
    let grant = await BillingGrant.findById("sub_owner");
    expect(grant.planId).to.equal("author_annual");
    expect(grant.priceId).to.equal("price_annual");
    expect((await allowance(owner)).plan).to.equal("author_annual");
    // Webhook updates (renewal, cancellation) keep resolving the legacy price.
    legacy = { ...legacy, cancel_at_period_end: true };
    await processBillingEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_owner" } } }, stripe);
    grant = await BillingGrant.findById("sub_owner");
    expect(grant.planId).to.equal("author_annual");
    expect(grant.cancelAtPeriodEnd).to.equal(true);
    // New subscriptions use the new price.
    await processBillingEvent({ type: "customer.subscription.created", data: { object: { id: "sub_new" } } }, stripe);
    expect((await BillingGrant.findById("sub_new")).planId).to.equal("author_annual");
  });
  it("recognizes a declared legacy price without a recorded one", async () => {
    config.STRIPE_AUTHOR_ANNUAL_PRICE = "price_annual_new";
    const stripe = { subscriptions: { retrieve: async () => subscription({ items: { data: [{ price: { id: "price_annual_old" }, current_period_end: Math.floor(future().getTime() / 1000) }] } }) } };
    await syncSubscription("sub_owner", stripe);
    expect((await BillingGrant.findById("sub_owner")).planId).to.equal("unknown");
    config.STRIPE_LEGACY_PRICES = "price_annual_old:author_annual";
    await syncSubscription("sub_owner", stripe);
    expect((await BillingGrant.findById("sub_owner")).planId).to.equal("author_annual");
    expect((await allowance(owner)).plan).to.equal("author_annual");
  });
  it("keeps historical one-time purchases after their price is replaced", async () => {
    const value = session(); value.id = "cs_old_pass";
    await fulfillCheckout("cs_old_pass", { checkout: { sessions: { retrieve: async () => value } } });
    expect((await allowance(owner, "repo")).plan).to.equal("author_pass");
    config.STRIPE_AUTHOR_PASS_PRICE = "price_pass_new";
    // A redelivered webhook for the old sale still fulfills and keeps the grant.
    await fulfillCheckout("cs_old_pass", { checkout: { sessions: { retrieve: async () => value } } });
    expect((await BillingGrant.findById("cs_old_pass")).revoked).to.not.equal(true);
    expect((await allowance(owner, "repo")).plan).to.equal("author_pass");
    // A sale at an old price never recorded is accepted once it is declared.
    const other = session(); other.id = "cs_older"; other.metadata.target = "other"; other.line_items.data[0].price.id = "price_pass_older";
    await rejects(fulfillCheckout("cs_older", { checkout: { sessions: { retrieve: async () => other } } }), "billing_invalid_purchase");
    config.STRIPE_LEGACY_PRICES = "price_pass_older:author_pass";
    await fulfillCheckout("cs_older", { checkout: { sessions: { retrieve: async () => other } } });
    expect((await allowance(owner, "other")).plan).to.equal("author_pass");
  });
  it("keeps a Never expire link online when reconciliation recovers its purchase", async () => {
    const { reconcileNeverExpiration, NEVER_EXPIRATION_GRACE_MS } = require("../src/core/billing/expiration");
    const now = new Date();
    await Repo.create({ repoId: "recovered", owner, status: "ready", options: { expirationMode: "never" }, billingNeverExpiresUntil: new Date(now.getTime() - 1000) });
    await reconcileNeverExpiration(now, async () => {
      await BillingGrant.create({ _id: "never-recovered", owner, scope: "repo:recovered", status: "paid", until: new Date("9999-12-31T00:00:00Z"), planId: "repo_never" });
    });
    const repo = await Repo.findOne({ repoId: "recovered" });
    expect(repo.options.expirationMode).to.equal("never");
    expect(repo.billingNeverExpiresUntil.getTime()).to.equal(now.getTime() + NEVER_EXPIRATION_GRACE_MS);
  });
  it("keeps automatic updates for a paid-slot repository while its owner subscribes", async () => {
    const { hasAutomaticUpdates } = require("../src/core/billing/expiration");
    await BillingGrant.create({ _id: "slot", owner, scope: "repo:slotted", status: "paid", until: new Date("9999-12-31T00:00:00Z"), planId: "repo_slot" });
    expect(await hasAutomaticUpdates(owner, "slotted")).to.equal(false);
    await BillingGrant.create({ _id: "author", owner, scope: `user:${owner}`, status: "active", until: future(), planId: "author_monthly" });
    expect(await hasAutomaticUpdates(owner, "slotted")).to.equal(true);
  });
  it("only reports conference hosting while its package payment stands", async () => {
    const utils = require("../src/server/routes/route-utils");
    const router = require("../src/server/routes/conference").default;
    const get = router.stack.find(layer => layer.route?.path === "/:conferenceID" && layer.route.methods.get).route.stack[0].handle;
    const originalUser = utils.getUser;
    utils.getUser = async () => ({ model: { id: "someone-else" }, isAdmin: false });
    try {
      await Conference.create({ conferenceID: "PAID", owners: [owner], status: "ready", startDate: new Date(Date.now() - 1000), endDate: future(), plan: { planID: "conference" } });
      await BillingGrant.create({ _id: "conf-paid", owner, scope: "conference:PAID", status: "paid", until: future(), planId: "conference" });
      const hosting = async () => { let body; await get({ params: { conferenceID: "PAID" } }, { json: value => { body = value; } }); return body.hosting; };
      expect(await hosting()).to.equal(true);
      await BillingGrant.updateOne({ _id: "conf-paid" }, { $set: { revoked: true } });
      expect(await hosting()).to.equal(false);
    } finally { utils.getUser = originalUser; }
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
    Object.assign(config, { STRIPE_SECRET_KEY: "sk_test_example", STRIPE_WEBHOOK_SECRET: "whsec_test_example", STRIPE_AUTHOR_MONTHLY_PRICE: "", STRIPE_AUTHOR_ANNUAL_PRICE: "", STRIPE_AUTHOR_PASS_PRICE: "", STRIPE_CONFERENCE_PRICE: "", STRIPE_CONFERENCE_SMALL_PRICE: "", STRIPE_CONFERENCE_LARGE_PRICE: "" });
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
