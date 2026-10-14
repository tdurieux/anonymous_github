const { expect } = require("chai");
const mongoose = require("mongoose");
require("ts-node/register/transpile-only");
const Users = require("../src/core/model/users/users.model").default;
const config = require("../src/config").default;
const alerts = require("../src/core/owner-notifications");
const { notifyOwnerAccessProblem: notify, resetOwnerAccessAlerts: reset, withOwnerAccessRecovery: recover } = alerts;
const describeMongo = process.env.TEST_MONGODB_URI ? describe : describe.skip;

describeMongo("recipient access alerts in MongoDB", function () {
  this.timeout(15000);
  let owner, otherOwner, resource, other, sent, nativeFetch, originalConfig;
  const coll = kind => mongoose.connection.collection({ repository: "anonymizedrepositories", gist: "anonymizedgists", "pull-request": "anonymizedpullrequests" }[kind]);
  const guards = () => mongoose.connection.collection(alerts.RECIPIENT_ALERTS);
  const recipient = () => alerts.recipientAlertKey("owner@example.com");
  async function create(ownerId, kind = "repository") {
    const id = new mongoose.Types.ObjectId(); await coll(kind).insertOne({ _id: id, owner: ownerId, repoId: String(id), status: "ready" }); return { kind, id: String(id) };
  }
  before(async () => {
    nativeFetch = global.fetch; originalConfig = { ...config };
    await mongoose.connect(process.env.TEST_MONGODB_URI, { dbName: "recipient_alerts_" + Date.now() });
    Object.assign(config, { RESEND_API_KEY: "test-key", EMAIL_FROM: "alerts@example.com", APP_HOSTNAME: "anonymous.example.com" });
  });
  after(async () => { global.fetch = nativeFetch; Object.assign(config, originalConfig); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => {
    for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
    owner = await Users.create({ username: "owner", emails: [{ email: "owner@example.com", default: true }] });
    otherOwner = await Users.create({ username: "other-owner", notificationEmail: "OWNER@example.com" });
    resource = await create(owner._id); other = await create(otherOwner._id, "gist"); sent = [];
    global.fetch = async (_url, options) => { sent.push(options); return { ok: true, status: 200 }; };
  });

  it("allows only one sender across owners, resources and case variations under concurrent failures", async () => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => notify(i % 2 ? owner.id : otherOwner.id, "token_expired", i % 2 ? resource : other)));
    expect(sent).to.have.length(1); expect(await guards().countDocuments({ _id: recipient() })).to.equal(1);
    expect(await mongoose.connection.collection("owner_access_alert_events").countDocuments({ state: "accepted" })).to.equal(1);
  });
  for (const kind of ["repository", "gist", "pull-request"]) {
    for (const status of ["archived", "expired", "expiring", "removed", "removing"]) it(`does not notify for ${status} ${kind}`, async () => {
      const inactive = await create(owner._id, kind);
      await coll(kind).updateOne({ _id: new mongoose.Types.ObjectId(inactive.id) }, { $set: { status } });
      await notify(owner.id, "token_expired", inactive);
      expect(sent).to.have.length(0); expect(await guards().findOne({ _id: recipient() })).to.equal(null);
      expect(await mongoose.connection.collection("owner_access_alert_events").countDocuments()).to.equal(0);
    });
  }
  it("cancels a send when the source is removed during audit preparation", async () => {
    const events = mongoose.connection.collection("owner_access_alert_events"), insert = events.insertOne;
    let entered, release; const gate = new Promise(resolve => { entered = resolve; });
    events.insertOne = async function (...args) { entered(); await new Promise(resolve => { release = resolve; }); return insert.apply(this, args); };
    const pending = notify(owner.id, "token_expired", resource);
    try {
      await gate;
      await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { status: "removed" } });
    } finally { events.insertOne = insert; release(); await pending; }
    expect(sent).to.have.length(0); expect(await guards().findOne({ _id: recipient() })).to.equal(null);
    expect((await coll(resource.kind).findOne({ _id: new mongoose.Types.ObjectId(resource.id) })).accessAlertClaimedAt).to.equal(undefined);
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
  });
  it("records the triggering resource and categorized failure without its address or source name", async () => {
    await notify(owner.id, "token_expired", resource);
    const records = await mongoose.connection.collection("owner_access_alert_events").find().toArray();
    expect(records).to.have.length(2);
    for (const record of records) {
      expect(String(record.owner)).to.equal(owner.id); expect(String(record.resourceId)).to.equal(resource.id);
      expect(record.resourceKind).to.equal(resource.kind); expect(record.generation).to.equal(null);
      expect(JSON.stringify(record)).not.to.include("owner@example.com");
    }
    expect(records.find(record => record.state === "prepared").failureCode).to.equal("token_expired");
  });
  for (const state of ["accepted", "failed"]) it(`restores a missing guard from ${state} provider history before serving traffic`, async () => {
    await mongoose.connection.collection("owner_access_alert_events").insertOne({ _id: "old/completion", attemptId: "old",
      recipientKey: recipient(), state, completedAt: new Date(1) });
    await Promise.all(Array.from({ length: 5 }, () => alerts.initializeOwnerAccessAlerts()));
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("recipient_notified");
    await notify(owner.id, "token_expired", resource); await notify(otherOwner.id, "token_expired", other);
    await reset(owner.id, resource); await recover(owner.id, resource, async () => {});
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(0);
    await alerts.initializeOwnerAccessAlerts(); expect(sent).to.have.length(0);
  });
  it("does not restore a delivery guard from an uncompleted preparation event", async () => {
    await mongoose.connection.collection("owner_access_alert_events").insertOne({ _id: "prepared", recipientKey: recipient(), state: "prepared", startedAt: new Date(1) });
    await alerts.initializeOwnerAccessAlerts(); expect(await guards().findOne({ _id: recipient() })).to.equal(null);
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(1);
  });
  it("resumes provider history restoration after a checkpointed startup failure", async () => {
    const events = mongoose.connection.collection("owner_access_alert_events");
    const keys = Array.from({ length: 105 }, (_, i) => alerts.recipientAlertKey(`old${i}@example.com`));
    await events.insertMany(keys.map((recipientKey, i) => ({ _id: String(i).padStart(3, "0") + "/completion",
      recipientKey, attemptId: String(i), state: "accepted", completedAt: new Date(1) })));
    const collection = guards(), update = collection.updateOne; let restored = 0;
    collection.updateOne = async function (filter, operation, ...args) {
      if (operation.$setOnInsert?.state === "recipient_notified" && ++restored === 103) throw new Error("interrupted history backfill");
      return update.call(this, filter, operation, ...args);
    };
    try { await alerts.initializeOwnerAccessAlerts(); throw new Error("Expected migration failure"); }
    catch (error) { expect(error.message).to.equal("interrupted history backfill"); }
    finally { collection.updateOne = update; }
    expect((await guards().findOne({ _id: "recipient-alerts-v1" })).deliveryProgress.id).to.equal("099/completion");
    await guards().updateOne({ _id: "recipient-alerts-v1" }, { $set: { leaseUntil: new Date(0) } });
    await alerts.initializeOwnerAccessAlerts();
    expect(await guards().countDocuments({ state: "recipient_notified" })).to.equal(105);
    expect((await guards().findOne({ _id: "recipient-alerts-v1" })).deliveryProgress.id).to.equal("104/completion");
    expect((await events.indexes()).some(index => index.name === "owner_access_alert_delivery_history" && index.partialFilterExpression)).to.equal(true);
    expect(sent).to.have.length(0);
  });
  it("does not reopen after reconnect alone, unrelated resource success, or failed recovery", async () => {
    await notify(owner.id, "token_expired", resource); await reset(owner.id);
    await recover(otherOwner.id, other, async () => {});
    try { await recover(owner.id, resource, async () => { throw new Error("Forbidden"); }); } catch { /* Expected. */ }
    await notify(owner.id, "token_expired", resource); await notify(otherOwner.id, "token_expired", other);
    expect(sent).to.have.length(1);
  });
  it("keeps suppression after recovery but allows a first alert to a new address", async () => {
    await notify(owner.id, "token_expired", resource);
    await reset(owner.id, resource); await recover(owner.id, resource, async () => {});
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("recovered");
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(1);
    await Users.updateOne({ _id: owner._id }, { $set: { notificationEmail: "new@example.com" } });
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(2);
    expect(sent[0].headers["Idempotency-Key"]).not.to.equal(sent[1].headers["Idempotency-Key"]);
    expect(await mongoose.connection.collection("owner_access_alert_events").countDocuments()).to.equal(4);
    await Users.updateOne({ _id: owner._id }, { $set: { notificationEmail: "OWNER@example.com" } });
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(2);
  });
  it("does not release a pending send when recovery races with provider delivery", async () => {
    let release, entered; const gate = new Promise(resolve => { entered = resolve; });
    global.fetch = async (_url, options) => { sent.push(options); entered(); await new Promise(resolve => { release = resolve; }); return { ok: true, status: 200 }; };
    const pending = notify(owner.id, "token_expired", resource); await gate;
    await reset(owner.id, resource); await recover(owner.id, resource, async () => {});
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
    release(); await pending;
  });
  it("rejects stale recovery after another owner action changes the generation", async () => {
    await notify(owner.id, "token_expired", resource); await reset(owner.id, resource);
    await recover(owner.id, resource, async () => { await reset(owner.id, resource); });
    expect(await guards().findOne({ _id: recipient() })).not.to.equal(null);
  });
  it("cancels an unsent claim before a paused sender can start dispatch", async () => {
    const collection = mongoose.connection.collection("owner_access_alert_events"), insert = collection.insertOne;
    let entered, release; const gate = new Promise(resolve => { entered = resolve; });
    collection.insertOne = async function (...args) { entered(); await new Promise(resolve => { release = resolve; }); return insert.apply(this, args); };
    try {
      const pending = notify(owner.id, "token_expired", resource); await gate;
      await reset(owner.id, resource); await recover(owner.id, resource, async () => {});
      release(); await pending; expect(sent).to.have.length(0);
      expect(await guards().findOne({ _id: recipient() })).to.equal(null);
    } finally { collection.insertOne = insert; }
  });
  it("fences a second owner action that races after recovery's final resource check", async () => {
    await notify(owner.id, "token_expired", resource); await reset(owner.id, resource);
    const collection = guards(), update = collection.updateOne;
    let entered, release; const gate = new Promise(resolve => { entered = resolve; });
    collection.updateOne = async function (filter, operation, ...args) {
      if (operation.$set?.state === "recovered") { entered(); await new Promise(resolve => { release = resolve; }); }
      return update.call(this, filter, operation, ...args);
    };
    try {
      const pending = recover(owner.id, resource, async () => {}); await gate;
      await reset(owner.id, resource); release(); await pending;
      expect((await guards().findOne({ _id: recipient() })).state).to.equal("accepted");
    } finally { collection.updateOne = update; }
  });
  it("does not accept a successful read of a stale source binding", async () => {
    await notify(owner.id, "token_expired", resource); await reset(owner.id, resource);
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { "source.repositoryName": "new/source" } });
    await recover(owner.id, resource, async () => {}, { "source.repositoryName": "old/source" });
    expect(await guards().findOne({ _id: recipient() })).not.to.equal(null);
  });
  for (const failure of ["rejection", "timeout"]) it(`retains the recipient guard after ${failure}`, async () => {
    global.fetch = async (_url, options) => { sent.push(options); if (failure === "timeout") throw new Error("timeout"); return { ok: false, status: 429 }; };
    await notify(owner.id, "token_expired", resource); await reset(owner.id);
    await notify(otherOwner.id, "repo_not_found", other); expect(sent).to.have.length(1);
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("failed");
  });
  it("keeps a removed resource's recipient guard and delivery history", async () => {
    await notify(owner.id, "token_expired", resource);
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { status: "removed" } });
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
    expect(await mongoose.connection.collection("owner_access_alert_events").countDocuments()).to.equal(2);
  });
  for (const step of ["resource update", "resource verification", "audit insertion", "dispatch transition"]) it(`releases an unsent guard after ${step} fails`, async () => {
    const collection = step.startsWith("resource") ? coll(resource.kind) : step === "audit insertion" ? mongoose.connection.collection("owner_access_alert_events") : guards();
    const method = step === "resource verification" ? "findOne" : step === "audit insertion" ? "insertOne" : "updateOne";
    const original = collection[method]; let calls = 0;
    collection[method] = async function (...args) {
      calls++;
      if ((step === "resource verification" && calls === 3)
        || (step === "dispatch transition" && args[1].$set?.state === "sending")
        || (step === "resource update" && args[1].$set?.accessAlertClaimedAt)
        || step === "audit insertion") throw new Error("transient database error");
      return original.apply(this, args);
    };
    try { await notify(owner.id, "token_expired", resource); }
    finally { collection[method] = original; }
    expect(sent).to.have.length(0); expect(await guards().findOne({ _id: recipient() })).to.equal(null);
    expect((await coll(resource.kind).findOne({ _id: new mongoose.Types.ObjectId(resource.id) })).accessAlertClaimedAt).to.equal(undefined);
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(1);
  });
  it("retains audit evidence while provider delivery is still in flight", async () => {
    let release, entered; const gate = new Promise(resolve => { entered = resolve; });
    global.fetch = async () => { entered(); await new Promise(resolve => { release = resolve; }); return { ok: true, status: 200 }; };
    const pending = notify(owner.id, "token_expired", resource); await gate;
    try {
      const record = await guards().findOne({ _id: recipient() });
      const event = await mongoose.connection.collection("owner_access_alert_events").findOne({ _id: record.attemptId });
      expect(event.state).to.equal("prepared"); expect(record.state).to.equal("sending");
    } finally { release(); await pending; }
  });
  it("reclaims a crashed pre-dispatch attempt without owner action under concurrent failures", async () => {
    await guards().insertOne({ _id: recipient(), owner: owner._id, resourceKind: resource.kind,
      resourceId: new mongoose.Types.ObjectId(resource.id), attemptId: "crashed-pending", state: "pending", claimedAt: new Date(0) });
    await Promise.all(Array.from({ length: 40 }, (_, i) => notify(i % 2 ? owner.id : otherOwner.id, "token_expired", i % 2 ? resource : other)));
    expect(sent).to.have.length(1);
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("accepted");
  });
  it("refreshes the resource fence when an old claim is reclaimed before guard insertion", async () => {
    await guards().insertOne({ _id: recipient(), owner: owner._id, resourceKind: resource.kind,
      resourceId: new mongoose.Types.ObjectId(resource.id), attemptId: "old-pending", state: "pending", claimedAt: new Date(0) });
    const users = mongoose.connection.collection("users"), update = users.updateOne;
    let entered, release; const gate = new Promise(resolve => { entered = resolve; });
    users.updateOne = async function (filter, operation, ...args) {
      if (Array.isArray(operation)) { entered(); await new Promise(resolve => { release = resolve; }); }
      return update.call(this, filter, operation, ...args);
    };
    const pending = notify(owner.id, "token_expired", resource);
    try { await gate; await alerts.initializeOwnerAccessAlerts(); }
    finally { users.updateOne = update; release(); await pending; }
    expect(sent).to.have.length(1);
    expect((await guards().findOne({ _id: recipient() })).resourceRevision).to.equal(1);
    expect((await coll(resource.kind).findOne({ _id: new mongoose.Types.ObjectId(resource.id) })).accessAlertClaimRevision).to.equal(2);
  });
  it("keeps recent pending claims and old sending claims blocked", async () => {
    await guards().insertOne({ _id: recipient(), owner: owner._id, resourceKind: resource.kind,
      resourceId: new mongoose.Types.ObjectId(resource.id), attemptId: "active-pending", state: "pending", claimedAt: new Date() });
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(0);
    await guards().updateOne({ _id: recipient() }, { $set: { state: "sending", claimedAt: new Date(0) } });
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(0);
    await alerts.initializeOwnerAccessAlerts();
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("sending");
  });
  it("reaps only expired unsent claims during startup and never reseeds them", async () => {
    await guards().insertOne({ _id: "recipient-alerts-v1", state: "ready" });
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { accessAlertClaimedAt: new Date(0), accessAlertAttemptId: recipient() } });
    for (const [key, state, date] of [[recipient(), "pending", new Date(0)], ["recent", "pending", new Date()],
      ["sending", "sending", new Date(0)], ["accepted", "accepted", new Date(0)], ["failed", "failed", new Date(0)]]) {
      await guards().insertOne({ _id: key, owner: owner._id, resourceKind: resource.kind,
        resourceId: new mongoose.Types.ObjectId(resource.id), attemptId: key, state, claimedAt: date });
    }
    await alerts.initializeOwnerAccessAlerts();
    expect(await guards().findOne({ _id: recipient() })).to.equal(null);
    for (const key of ["recent", "sending", "accepted", "failed"]) expect(await guards().findOne({ _id: key })).not.to.equal(null);
    await alerts.initializeOwnerAccessAlerts();
    expect(await guards().findOne({ _id: recipient() })).to.equal(null);
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(1);
  });
  it("fences a paused sender after another reader reclaims its expired pending claim", async () => {
    const collection = mongoose.connection.collection("owner_access_alert_events"), insert = collection.insertOne;
    let entered, release; const gate = new Promise(resolve => { entered = resolve; });
    let pausedOnce = false;
    collection.insertOne = async function (...args) {
      if (!pausedOnce) { pausedOnce = true; entered(); await new Promise(resolve => { release = resolve; }); }
      return insert.apply(this, args);
    };
    const paused = notify(owner.id, "token_expired", resource);
    try {
      await gate;
      await guards().updateOne({ _id: recipient() }, { $set: { claimedAt: new Date(0) } });
      await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
    } finally { collection.insertOne = insert; release(); await paused; }
    expect(sent).to.have.length(1);
    expect((await guards().findOne({ _id: recipient() })).owner.toString()).to.equal(otherOwner.id);
  });
  it("cannot reclaim a pending attempt that starts dispatch before cancellation", async () => {
    await guards().insertOne({ _id: recipient(), owner: owner._id, resourceKind: resource.kind,
      resourceId: new mongoose.Types.ObjectId(resource.id), attemptId: "racing-dispatch", state: "pending", claimedAt: new Date(0) });
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { accessAlertClaimedAt: new Date(0), accessAlertAttemptId: "racing-dispatch" } });
    const collection = guards(), update = collection.updateOne;
    collection.updateOne = async function (filter, operation, ...args) {
      if (operation.$set?.state === "cancelled") await update.call(this, { _id: recipient(), state: "pending", attemptId: "racing-dispatch" }, { $set: { state: "sending" } });
      return update.call(this, filter, operation, ...args);
    };
    try { await notify(otherOwner.id, "token_expired", other); }
    finally { collection.updateOne = update; }
    expect(sent).to.have.length(0); expect((await guards().findOne({ _id: recipient() })).state).to.equal("sending");
    expect((await coll(resource.kind).findOne({ _id: new mongoose.Types.ObjectId(resource.id) })).accessAlertAttemptId).to.equal("racing-dispatch");
  });
  for (const state of ["pending", "cancelled"]) it(`clears a crashed unsent ${state} attempt's legacy fields before migration`, async () => {
    const attemptId = `crashed-${state}`;
    await guards().insertOne({ _id: recipient(), owner: owner._id, resourceKind: resource.kind,
      resourceId: new mongoose.Types.ObjectId(resource.id), generation: "old-generation", attemptId, state,
      claimedAt: state === "pending" ? new Date(0) : new Date() });
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: {
      accessAlertGeneration: "old-generation", accessAlertClaimedAt: new Date(0), accessAlertAttemptId: attemptId,
    } });
    await alerts.initializeOwnerAccessAlerts();
    expect(await guards().findOne({ _id: recipient() })).to.equal(null);
    const row = await coll(resource.kind).findOne({ _id: new mongoose.Types.ObjectId(resource.id) });
    expect(row.accessAlertClaimedAt).to.equal(undefined); expect(row.accessAlertAttemptId).to.equal(undefined);
    expect(sent).to.have.length(0);
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(1);
  });
  for (const changed of ["generation", "attempt"]) it(`preserves newer legacy fields when the ${changed} no longer matches the cancelled attempt`, async () => {
    await guards().insertOne({ _id: "recipient-alerts-v1", state: "ready" });
    await guards().insertOne({ _id: recipient(), owner: owner._id, resourceKind: resource.kind,
      resourceId: new mongoose.Types.ObjectId(resource.id), generation: "old-generation", attemptId: "old-attempt", state: "pending", claimedAt: new Date(0) });
    const generation = changed === "generation" ? "new-generation" : "old-generation";
    const attemptId = changed === "attempt" ? "new-attempt" : "old-attempt";
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: {
      accessAlertGeneration: generation, accessAlertClaimedAt: new Date(1234), accessAlertAttemptId: attemptId,
    } });
    await alerts.initializeOwnerAccessAlerts();
    expect(await guards().findOne({ _id: recipient() })).to.equal(null);
    const row = await coll(resource.kind).findOne({ _id: new mongoose.Types.ObjectId(resource.id) });
    expect(row.accessAlertClaimedAt.getTime()).to.equal(1234); expect(row.accessAlertAttemptId).to.equal(attemptId);
  });
  it("resumes cancelled metadata cleanup after a database failure without creating false legacy evidence", async () => {
    const collection = coll(resource.kind), update = collection.updateOne, read = collection.findOne;
    let reads = 0;
    collection.findOne = async function (...args) { if (++reads === 3) throw new Error("verification failed"); return read.apply(this, args); };
    collection.updateOne = async function (filter, operation, ...args) {
      if (Array.isArray(operation)) throw new Error("cleanup unavailable");
      return update.call(this, filter, operation, ...args);
    };
    try { await notify(owner.id, "token_expired", resource); }
    finally { collection.findOne = read; collection.updateOne = update; }
    expect(sent).to.have.length(0); expect((await guards().findOne({ _id: recipient() })).state).to.equal("cancelled");
    await alerts.initializeOwnerAccessAlerts();
    expect(await guards().findOne({ _id: recipient() })).to.equal(null);
    expect((await collection.findOne({ _id: new mongoose.Types.ObjectId(resource.id) })).accessAlertClaimedAt).to.equal(undefined);
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(1);
  });
  it("cleans recent pending legacy fields once deployment has stopped every writer", async () => {
    await guards().insertOne({ _id: "recipient-alerts-v1", state: "ready" });
    await guards().insertOne({ _id: recipient(), owner: owner._id, resourceKind: resource.kind,
      resourceId: new mongoose.Types.ObjectId(resource.id), attemptId: "recent-unsent", state: "pending", claimedAt: new Date() });
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: {
      accessAlertClaimedAt: new Date(), accessAlertAttemptId: "recent-unsent",
    } });
    await alerts.prepareLegacyOwnerAlertMigration(); await alerts.initializeOwnerAccessAlerts();
    expect(await guards().findOne({ _id: recipient() })).to.equal(null);
    expect((await coll(resource.kind).findOne({ _id: new mongoose.Types.ObjectId(resource.id) })).accessAlertClaimedAt).to.equal(undefined);
  });
  it("preserves an untagged legacy delivery written during rollback while cancelling a native pending attempt", async () => {
    await guards().insertOne({ _id: "recipient-alerts-v1", state: "ready" });
    await guards().insertOne({ _id: recipient(), owner: owner._id, resourceKind: resource.kind,
      resourceId: new mongoose.Types.ObjectId(resource.id), attemptId: "native-unsent", state: "pending", claimedAt: new Date() });
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { accessAlertClaimedAt: new Date() } });
    await alerts.prepareLegacyOwnerAlertMigration(); await alerts.initializeOwnerAccessAlerts();
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("legacy");
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(0);
    await reset(owner.id, resource); await recover(owner.id, resource, async () => {});
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(0);
  });
  it("blocks dispatch while an owner reset has advanced the guard revision but not the resource generation", async () => {
    const events = mongoose.connection.collection("owner_access_alert_events"), insert = events.insertOne;
    const collection = coll(resource.kind), updateMany = collection.updateMany;
    let prepared, releasePrepared, resetting, releaseReset;
    const atPrepared = new Promise(resolve => { prepared = resolve; });
    const atReset = new Promise(resolve => { resetting = resolve; });
    events.insertOne = async function (...args) { prepared(); await new Promise(resolve => { releasePrepared = resolve; }); return insert.apply(this, args); };
    collection.updateMany = async function (...args) { resetting(); await new Promise(resolve => { releaseReset = resolve; }); return updateMany.apply(this, args); };
    const pending = notify(owner.id, "token_expired", resource);
    let action;
    try {
      await atPrepared; action = reset(owner.id, resource); await atReset;
      expect((await guards().findOne({ _id: recipient() })).resetRevision).to.equal(1);
      releasePrepared(); await pending;
      expect(sent).to.have.length(0);
      const row = await collection.findOne({ _id: new mongoose.Types.ObjectId(resource.id) });
      expect(row.accessAlertGeneration).to.equal(undefined); expect(row.accessAlertClaimedAt).to.equal(undefined);
    } finally {
      events.insertOne = insert; collection.updateMany = updateMany;
      if (releasePrepared) releasePrepared(); if (releaseReset) releaseReset();
      await pending; if (action) await action;
    }
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(1);
  });
  it("invalidates an old failure when reset starts before its recipient guard exists", async () => {
    const lookup = Users.findOne, collection = coll(resource.kind), updateMany = collection.updateMany;
    let entered, release, resetting, releaseReset;
    const atLookup = new Promise(resolve => { entered = resolve; });
    const atReset = new Promise(resolve => { resetting = resolve; });
    Users.findOne = function (...args) { return { lean: async () => {
      entered(); await new Promise(resolve => { release = resolve; }); return lookup.apply(Users, args).lean();
    } }; };
    collection.updateMany = async function (...args) { resetting(); await new Promise(resolve => { releaseReset = resolve; }); return updateMany.apply(this, args); };
    const pending = notify(owner.id, "token_expired", resource); let action;
    try {
      await atLookup; action = reset(owner.id, resource); await atReset;
      expect(await guards().findOne({ _id: recipient() })).to.equal(null);
      release(); await pending; expect(sent).to.have.length(0);
      expect((await collection.findOne({ _id: new mongoose.Types.ObjectId(resource.id) })).accessAlertClaimedAt).to.equal(undefined);
    } finally {
      Users.findOne = lookup; collection.updateMany = updateMany;
      if (release) release(); if (releaseReset) releaseReset(); await pending; if (action) await action;
    }
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(1);
  });
  it("prevents a cancelled sender from recreating legacy fields after its database write resumes", async () => {
    const collection = coll(resource.kind), update = collection.updateOne;
    let entered, release; const gate = new Promise(resolve => { entered = resolve; });
    collection.updateOne = async function (filter, operation, ...args) {
      if (operation.$set?.accessAlertClaimedAt) { entered(); await new Promise(resolve => { release = resolve; }); }
      return update.call(this, filter, operation, ...args);
    };
    const pending = notify(owner.id, "token_expired", resource);
    try {
      await gate; await guards().updateOne({ _id: recipient() }, { $set: { claimedAt: new Date(0) } });
      await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
    } finally { collection.updateOne = update; release(); await pending; }
    const row = await collection.findOne({ _id: new mongoose.Types.ObjectId(resource.id) });
    expect(row.accessAlertClaimedAt).to.equal(undefined); expect(row.accessAlertClaimRevision).to.equal(1);
    expect(sent).to.have.length(1);
  });
  it("reaps a crashed pre-provider attempt after legacy preparation completed", async () => {
    await guards().insertOne({ _id: recipient(), owner: owner._id, resourceKind: resource.kind,
      resourceId: new mongoose.Types.ObjectId(resource.id), attemptId: "prepared-not-sent", state: "pending", resourceRevision: 0, claimedAt: new Date(0) });
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: {
      accessAlertClaimedAt: new Date(0), accessAlertAttemptId: "prepared-not-sent", accessAlertClaimRevision: 1,
    } });
    await alerts.initializeOwnerAccessAlerts();
    expect(await guards().findOne({ _id: recipient() })).to.equal(null); expect(sent).to.have.length(0);
    const row = await coll(resource.kind).findOne({ _id: new mongoose.Types.ObjectId(resource.id) });
    expect(row.accessAlertClaimedAt).to.equal(undefined); expect(row.accessAlertClaimRevision).to.equal(2);
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(1);
  });
  for (const accepted of [true, false]) it(`applies recovery recorded during an in-flight ${accepted ? "accepted" : "rejected"} delivery`, async () => {
    let entered, release; const gate = new Promise(resolve => { entered = resolve; });
    global.fetch = async (_url, options) => {
      sent.push(options); if (sent.length === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
      return { ok: accepted, status: accepted ? 200 : 403 };
    };
    const pending = notify(owner.id, "token_expired", resource);
    try {
      await gate; await reset(owner.id, resource); await recover(owner.id, resource, async () => {});
      const record = await guards().findOne({ _id: recipient() }); expect(record.state).to.equal("sending");
      expect(record.deferredRecoveries).to.have.length(1);
      await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
    } finally { release(); await pending; }
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("recovered");
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
  });
  it("invalidates in-flight recovery evidence after a newer reset", async () => {
    let entered, release; const gate = new Promise(resolve => { entered = resolve; });
    global.fetch = async (_url, options) => {
      sent.push(options); if (sent.length === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
      return { ok: true, status: 200 };
    };
    const pending = notify(owner.id, "token_expired", resource);
    try {
      await gate; await reset(owner.id, resource); await recover(owner.id, resource, async () => {}); await reset(owner.id, resource);
    } finally { release(); await pending; }
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("accepted");
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
    await recover(owner.id, resource, async () => {});
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
  });
  it("invalidates deferred recovery if its source binding changes before delivery completes", async () => {
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { source: { repositoryName: "owner/repo" } } });
    let entered, release; const gate = new Promise(resolve => { entered = resolve; });
    global.fetch = async (_url, options) => {
      sent.push(options); if (sent.length === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
      return { ok: true, status: 200 };
    };
    const pending = notify(owner.id, "token_expired", resource);
    try {
      await gate; await reset(owner.id, resource);
      await recover(owner.id, resource, async () => {}, { "source.repositoryName": "owner/repo" });
      await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { "source.repositoryName": "new/repo" } });
    } finally { release(); await pending; }
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("accepted");
    await recover(owner.id, resource, async () => {}, { "source.repositoryName": "new/repo" });
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
  });
  it("rejects dispatch when reset starts after the guard reservation but before the owner commitment", async () => {
    const collection = guards(), update = collection.updateOne, updateMany = collection.updateMany;
    let entered, release, resetting, releaseReset;
    const gate = new Promise(resolve => { entered = resolve; }), resetGate = new Promise(resolve => { resetting = resolve; });
    collection.updateOne = async function (filter, operation, ...args) {
      const result = await update.call(this, filter, operation, ...args);
      if (operation.$set?.state === "sending") { entered(); await new Promise(resolve => { release = resolve; }); }
      return result;
    };
    collection.updateMany = async function (...args) { resetting(); await new Promise(resolve => { releaseReset = resolve; }); return updateMany.apply(this, args); };
    const pending = notify(owner.id, "token_expired", resource); let action;
    try {
      await gate; action = reset(owner.id, resource); await resetGate;
      expect((await guards().findOne({ _id: recipient() })).state).to.equal("sending");
      release(); await pending; expect(sent).to.have.length(0);
      expect(await guards().findOne({ _id: recipient() })).to.equal(null);
    } finally {
      collection.updateOne = update; collection.updateMany = updateMany;
      if (release) release(); if (releaseReset) releaseReset(); await pending; if (action) await action;
    }
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(1);
  });
  it("applies fresh recovery recorded before the reset lease is cleared without another upstream read", async () => {
    await notify(owner.id, "token_expired", resource);
    const users = mongoose.connection.collection("users"), update = users.updateOne;
    let entered, release; const gate = new Promise(resolve => { entered = resolve; });
    users.updateOne = async function (filter, operation, ...args) {
      if (operation.$unset?.accessAlertResetUntil !== undefined) { entered(); await new Promise(resolve => { release = resolve; }); }
      return update.call(this, filter, operation, ...args);
    };
    const action = reset(owner.id, resource);
    try {
      await gate; await recover(owner.id, resource, async () => {});
      expect((await guards().findOne({ _id: recipient() })).deferredRecoveries).to.have.length(1);
    } finally { users.updateOne = update; release(); await action; }
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("recovered");
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
  });
  it("retries saved recovery after a crashed reset lease expires", async () => {
    await notify(owner.id, "token_expired", resource); await reset(owner.id, resource);
    await mongoose.connection.collection("users").updateOne({ _id: owner._id }, { $set: { accessAlertResetUntil: new Date(Date.now() + 150) } });
    await recover(owner.id, resource, async () => {});
    expect(await guards().findOne({ _id: recipient() })).not.to.equal(null);
    for (let i = 0; i < 100 && (await guards().findOne({ _id: recipient() }))?.state !== "recovered"; i++) await new Promise(resolve => global.setTimeout(resolve, 20));
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("recovered");
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
  });
  for (const state of ["prepared", "cancelled", "committed"]) it(`reconciles interrupted guard reservation with a ${state} owner dispatch record`, async () => {
    const attemptId = `interrupted-${state}`;
    await guards().insertMany([{ _id: "recipient-alerts-v1", state: "ready" }, {
      _id: recipient(), owner: owner._id, resourceKind: resource.kind, resourceId: new mongoose.Types.ObjectId(resource.id),
      attemptId, state: "sending", dispatchPrepared: true, resourceRevision: 0, claimedAt: new Date(0),
    }]);
    await mongoose.connection.collection("users").updateOne({ _id: owner._id }, { $set: {
      [`accessAlertDispatches.${attemptId}`]: { state, claimedAt: new Date(0) },
    } });
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: {
      accessAlertClaimedAt: new Date(0), accessAlertAttemptId: attemptId, accessAlertClaimRevision: 1,
    } });
    await alerts.initializeOwnerAccessAlerts();
    const record = await guards().findOne({ _id: recipient() });
    const account = await mongoose.connection.collection("users").findOne({ _id: owner._id });
    if (state === "committed") {
      expect(record.state).to.equal("sending"); expect(account.accessAlertDispatches[attemptId].state).to.equal(state);
    } else {
      expect(record).to.equal(null); expect(account.accessAlertDispatches[attemptId]).to.equal(undefined);
      expect((await coll(resource.kind).findOne({ _id: new mongoose.Types.ObjectId(resource.id) })).accessAlertClaimedAt).to.equal(undefined);
    }
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(state === "committed" ? 0 : 1);
  });
  it("prunes expired uncommitted owner dispatch records and cleans completed attempts", async () => {
    await mongoose.connection.collection("users").updateOne({ _id: owner._id }, { $set: { accessAlertDispatches: {
      abandoned: { state: "prepared", claimedAt: new Date(0) }, cancelled: { state: "cancelled", claimedAt: new Date(0) },
      unknown: { state: "committed", claimedAt: new Date(0) },
    } } });
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(1);
    const account = await mongoose.connection.collection("users").findOne({ _id: owner._id });
    expect(Object.keys(account.accessAlertDispatches)).to.deep.equal(["unknown"]);
  });
  it("keeps shared-address suppression when the original owner is banned", async () => {
    await notify(owner.id, "token_expired", resource);
    await Users.updateOne({ _id: owner._id }, { $set: { status: "banned" } });
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
  });
  it("resumes an indexed migration from its last completed checkpoint", async () => {
    await Users.updateOne({ _id: otherOwner._id }, { $set: { notificationEmail: "second@example.com" } });
    const second = await create(otherOwner._id);
    await coll("repository").updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { accessAlertClaimedAt: new Date(1) } });
    await coll("repository").updateOne({ _id: new mongoose.Types.ObjectId(second.id) }, { $set: { accessAlertClaimedAt: new Date(2) } });
    await guards().insertOne({ _id: "recipient-alerts-v1", state: "new", leaseUntil: new Date(0),
      progress: { repository: { claimedAt: new Date(1), id: new mongoose.Types.ObjectId(resource.id) } } });
    await alerts.initializeOwnerAccessAlerts();
    expect(await guards().findOne({ _id: recipient() })).to.equal(null);
    expect(await guards().findOne({ _id: alerts.recipientAlertKey("second@example.com") })).not.to.equal(null);
    expect((await guards().findOne({ _id: "recipient-alerts-v1" })).progress.repository.claimedAt.getTime()).to.equal(2);
    expect((await coll("repository").indexes()).some(i => i.name === "owner_access_alert_backfill" && i.partialFilterExpression)).to.equal(true);
  });
  it("confirms recovery on a fresh uncached file read but never on a cache hit", async () => {
    const database = require("../src/server/database");
    const GitHubStream = require("../src/core/source/GitHubStream").default;
    const storage = require("../src/core/storage").default;
    const { Readable } = require("stream");
    const originals = { isConnected: database.isConnected, fileInfo: storage.fileInfo, write: storage.write, read: storage.read };
    await coll("repository").updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { repoId: resource.id, source: { repositoryName: "owner/repo", commit: "pinned" } } });
    let cached = false;
    database.isConnected = true;
    storage.fileInfo = async () => { if (!cached) throw Object.assign(new Error("miss"), { code: "ENOENT" }); return { size: 11, contentType: "text/plain" }; };
    storage.write = async (_repo, _path, input) => { for await (const _chunk of input) { /* Consume the upstream stream. */ } cached = true; };
    storage.read = async () => Readable.from(["fresh-bytes"]);
    try {
      await notify(owner.id, "token_expired", resource); await reset(owner.id, resource);
      const source = new GitHubStream({ repoId: resource.id, organization: "owner", repoName: "repo", commit: "pinned", getToken: async () => "mock-token" });
      source.downloadWithFallback = async () => Readable.from(["fresh-bytes"]);
      const read = () => source.getFileContentCache("a.txt", resource.id, () => ({ sha: "a".repeat(40), size: 11 }));
      (await read()).destroy(); expect((await guards().findOne({ _id: recipient() })).state).to.equal("recovered");
      const secondKey = alerts.recipientAlertKey("second@example.com");
      await Users.updateOne({ _id: owner._id }, { $set: { notificationEmail: "second@example.com" } });
      await notify(owner.id, "token_expired", resource); await reset(owner.id, resource);
      (await read()).destroy(); expect((await guards().findOne({ _id: secondKey })).state).to.equal("accepted");
    } finally { database.isConnected = originals.isConnected; storage.fileInfo = originals.fileInfo; storage.write = originals.write; storage.read = originals.read; }
  });
  it("confirms recovery when a successful scheduled refresh finds the same commit", async () => {
    const Repository = require("../src/core/Repository").default;
    const Model = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
    const github = require("../src/core/source/GitHubRepository");
    const original = github.getRepositoryFromGitHub;
    const source = { repositoryName: "owner/repo", commit: "pinned", branch: "main" };
    await coll("repository").updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { source } });
    const repo = new Repository(new Model({ _id: resource.id, owner: owner._id, repoId: resource.id, status: "ready",
      source, lastView: new Date(0), options: { update: true, expirationMode: "never" } }));
    repo.getToken = async () => "mock-token";
    github.getRepositoryFromGitHub = async () => ({ fullName: "owner/repo", model: { defaultBranch: "main" },
      branches: async () => [{ name: "main", commit: "pinned" }], getCommitInfo: async () => { throw new Error("Unexpected commit fetch"); } });
    try {
      await notify(owner.id, "token_expired", resource); await reset(owner.id, resource);
      await repo.updateIfNeeded({ force: false });
      expect((await guards().findOne({ _id: recipient() })).state).to.equal("recovered");
    } finally { github.getRepositoryFromGitHub = original; }
  });
  it("seeds old claims once while five instances start concurrently", async () => {
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { accessAlertClaimedAt: new Date() } });
    await Promise.all(Array.from({ length: 5 }, () => alerts.initializeOwnerAccessAlerts()));
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("legacy");
    await notify(otherOwner.id, "repo_not_found", other); expect(sent).to.have.length(0);
    await reset(owner.id, resource); await recover(owner.id, resource, async () => {});
    await alerts.initializeOwnerAccessAlerts(); expect((await guards().findOne({ _id: recipient() })).state).to.equal("recovered");
  });
  it("preserves every legacy claim for a shared address until each triggering resource recovers", async () => {
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { accessAlertClaimedAt: new Date(1) } });
    await coll(other.kind).updateOne({ _id: new mongoose.Types.ObjectId(other.id) }, { $set: { accessAlertClaimedAt: new Date(2) } });
    await alerts.initializeOwnerAccessAlerts();
    expect((await guards().findOne({ _id: recipient() })).legacyClaims).to.have.length(2);
    await reset(owner.id, resource); await recover(owner.id, resource, async () => {});
    expect((await guards().findOne({ _id: recipient() })).legacyClaims.filter(claim => !claim.recovered)).to.have.length(1);
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(0);
    await reset(otherOwner.id, other); await recover(otherOwner.id, other, async () => {});
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("recovered");
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(0);
  });
  it("does not retire a legacy group when only its first triggering resource is removed", async () => {
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { accessAlertClaimedAt: new Date(1) } });
    await coll(other.kind).updateOne({ _id: new mongoose.Types.ObjectId(other.id) }, { $set: { accessAlertClaimedAt: new Date(2) } });
    await alerts.initializeOwnerAccessAlerts();
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { status: "removed" } });
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(0);
    await reset(otherOwner.id, other); await recover(otherOwner.id, other, async () => {});
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(0);
  });
  it("atomically marks concurrent legacy recoveries without releasing suppression", async () => {
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { accessAlertClaimedAt: new Date(1) } });
    await coll(other.kind).updateOne({ _id: new mongoose.Types.ObjectId(other.id) }, { $set: { accessAlertClaimedAt: new Date(2) } });
    await alerts.initializeOwnerAccessAlerts(); await reset(owner.id, resource); await reset(otherOwner.id, other);
    await Promise.all([recover(owner.id, resource, async () => {}), recover(otherOwner.id, other, async () => {})]);
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("recovered");
  });
  it("requires a fresh read after a newer reset of a partially recovered legacy group", async () => {
    for (const item of [resource, other]) await coll(item.kind).updateOne({ _id: new mongoose.Types.ObjectId(item.id) }, { $set: { accessAlertClaimedAt: new Date(1) } });
    await alerts.initializeOwnerAccessAlerts();
    await reset(owner.id, resource); await recover(owner.id, resource, async () => {});
    await reset(owner.id, resource);
    await reset(otherOwner.id, other); await recover(otherOwner.id, other, async () => {});
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(0);
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("legacy");
    await recover(owner.id, resource, async () => {});
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(0);
  });
  it("fences legacy claim mutation when reset races after the final resource check", async () => {
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { accessAlertClaimedAt: new Date(1) } });
    await alerts.initializeOwnerAccessAlerts(); await reset(owner.id, resource);
    const collection = guards(), update = collection.updateOne;
    let entered, release; const gate = new Promise(resolve => { entered = resolve; });
    collection.updateOne = async function (filter, operation, ...args) {
      if (filter.attemptId && Array.isArray(operation)) { entered(); await new Promise(resolve => { release = resolve; }); }
      return update.call(this, filter, operation, ...args);
    };
    const pending = recover(owner.id, resource, async () => {});
    try { await gate; await reset(owner.id, resource); }
    finally { collection.updateOne = update; release(); await pending; }
    const record = await guards().findOne({ _id: recipient() });
    expect(record.state).to.equal("legacy"); expect(record.legacyClaims[0].recovered).to.equal(false);
  });
  it("reconciles claims written by legacy instances after rollback without reseeding ordinary restarts", async () => {
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { accessAlertClaimedAt: new Date(1) } });
    await alerts.initializeOwnerAccessAlerts(); await reset(owner.id, resource); await recover(owner.id, resource, async () => {});
    await alerts.initializeOwnerAccessAlerts(); expect((await guards().findOne({ _id: recipient() })).state).to.equal("recovered");
    await coll(other.kind).updateOne({ _id: new mongoose.Types.ObjectId(other.id) }, { $set: { accessAlertClaimedAt: new Date() } });
    await alerts.prepareLegacyOwnerAlertMigration();
    const marker = await guards().findOne({ _id: "recipient-alerts-v1" }); expect(marker.state).to.equal("new"); expect(marker.progress).to.equal(undefined);
    await alerts.initializeOwnerAccessAlerts(); await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(0);
    expect((await guards().findOne({ _id: recipient() })).legacyClaims.filter(claim => !claim.recovered)).to.have.length(1);
    await reset(otherOwner.id, other); await recover(otherOwner.id, other, async () => {});
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(0);
  });
  it("preserves a native guard's origin when rollback reconciliation adds another legacy claim", async () => {
    await alerts.initializeOwnerAccessAlerts(); await notify(owner.id, "token_expired", resource); await reset(owner.id, resource);
    await coll(other.kind).updateOne({ _id: new mongoose.Types.ObjectId(other.id) }, { $set: { accessAlertClaimedAt: new Date() } });
    await alerts.prepareLegacyOwnerAlertMigration(); await alerts.initializeOwnerAccessAlerts();
    expect((await guards().findOne({ _id: recipient() })).legacyClaims.filter(claim => !claim.recovered)).to.have.length(2);
    await reset(otherOwner.id, other); await recover(otherOwner.id, other, async () => {});
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
    await recover(owner.id, resource, async () => {});
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
  });
  it("keeps suppression through removal, reactivation, reset and recovery", async () => {
    await notify(owner.id, "token_expired", resource);
    const original = await guards().findOne({ _id: recipient() });
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { status: "removed" } });
    await notify(otherOwner.id, "token_expired", other);
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { status: "ready" } });
    await reset(owner.id, resource); await recover(owner.id, resource, async () => {});
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
    expect((await guards().findOne({ _id: recipient() })).attemptId).to.equal(original.attemptId);
  });
  for (const accepted of [true, false]) it(`retries the guard update after a definite ${accepted ? "accepted" : "rejected"} provider response`, async () => {
    const collection = guards(), update = collection.updateOne; let writes = 0;
    global.fetch = async (_url, options) => { sent.push(options); return { ok: accepted, status: accepted ? 200 : 403 }; };
    collection.updateOne = async function (filter, operation, ...args) {
      if (["accepted", "failed"].includes(operation.$set?.state)) {
        expect(await mongoose.connection.collection("owner_access_alert_events").findOne({ _id: `${filter.attemptId}/completion` })).not.to.equal(null);
        if (++writes === 1) throw new Error("transient result write failure");
      }
      return update.call(this, filter, operation, ...args);
    };
    try { await notify(owner.id, "token_expired", resource); }
    finally { collection.updateOne = update; }
    expect(writes).to.equal(2); expect(sent).to.have.length(1);
    expect((await guards().findOne({ _id: recipient() })).state).to.equal(accepted ? "accepted" : "failed");
  });
  for (const startup of [true, false]) it(`reconciles a durable provider result during ${startup ? "startup" : "the next notification"}`, async () => {
    await alerts.initializeOwnerAccessAlerts();
    const collection = guards(), update = collection.updateOne; let writes = 0;
    collection.updateOne = async function (filter, operation, ...args) {
      if (["accepted", "failed"].includes(operation.$set?.state)) { writes++; throw new Error("database unavailable"); }
      return update.call(this, filter, operation, ...args);
    };
    try { await notify(owner.id, "token_expired", resource); }
    finally { collection.updateOne = update; }
    expect(writes).to.equal(3); expect((await guards().findOne({ _id: recipient() })).state).to.equal("sending");
    if (startup) await alerts.initializeOwnerAccessAlerts(); else await notify(otherOwner.id, "token_expired", other);
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("accepted"); expect(sent).to.have.length(1);
    await reset(owner.id, resource); await recover(owner.id, resource, async () => {});
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(1);
  });
  it("records a provider completion once after its insertion acknowledgement is lost", async () => {
    const collection = mongoose.connection.collection("owner_access_alert_events"), insert = collection.insertOne;
    let lost = false;
    collection.insertOne = async function (record, ...args) {
      const result = await insert.call(this, record, ...args);
      if (record.state === "accepted" && !lost) { lost = true; throw new Error("lost acknowledgement"); }
      return result;
    };
    try { await notify(owner.id, "token_expired", resource); }
    finally { collection.insertOne = insert; }
    expect(lost).to.equal(true); expect(sent).to.have.length(1);
    expect(await collection.countDocuments({ state: "accepted" })).to.equal(1);
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("accepted");
  });
  it("does not let a late provider-result write resurrect a recovered guard", async () => {
    const collection = guards(), update = collection.updateOne;
    let entered, release, paused = false; const gate = new Promise(resolve => { entered = resolve; });
    collection.updateOne = async function (filter, operation, ...args) {
      if (operation.$set?.state === "accepted" && !paused) { paused = true; entered(); await new Promise(resolve => { release = resolve; }); }
      return update.call(this, filter, operation, ...args);
    };
    const pending = notify(owner.id, "token_expired", resource);
    try {
      await gate; await notify(otherOwner.id, "token_expired", other);
      await reset(owner.id, resource); await recover(owner.id, resource, async () => {});
    } finally { collection.updateOne = update; release(); await pending; }
    expect(sent).to.have.length(1); expect((await guards().findOne({ _id: recipient() })).state).to.equal("recovered");
  });
  it("confirms truncated-file metadata recovery only on a successful fresh matching-source probe", async () => {
    const database = require("../src/server/database");
    const GitHubStream = require("../src/core/source/GitHubStream").default;
    const utils = require("../src/core/GitHubUtils");
    const originals = { isConnected: database.isConnected, octokit: utils.octokit };
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { repoId: resource.id, source: { repositoryName: "owner/repo", commit: "pinned" } } });
    let response = { type: "file", sha: "a".repeat(40), size: 11 };
    database.isConnected = true;
    utils.octokit = () => ({ repos: { getContent: async () => { if (response instanceof Error) throw response; return { data: response }; } } });
    const source = new GitHubStream({ repoId: resource.id, organization: "owner", repoName: "repo", commit: "pinned", getToken: async () => "mock-token" });
    try {
      await notify(owner.id, "token_expired", resource); await reset(owner.id, resource);
      expect((await source.fetchFileInfoFromPath("a.txt")).sha).to.equal("a".repeat(40));
      expect((await guards().findOne({ _id: recipient() })).state).to.equal("recovered");
      const secondKey = alerts.recipientAlertKey("second@example.com");
      await Users.updateOne({ _id: owner._id }, { $set: { notificationEmail: "second@example.com" } });
      await notify(owner.id, "token_expired", resource); await reset(owner.id, resource);
      response = { type: "dir" }; expect(await source.fetchFileInfoFromPath("a.txt")).to.equal(null);
      expect((await guards().findOne({ _id: secondKey })).state).to.equal("accepted");
      response = Object.assign(new Error("Forbidden"), { status: 403 });
      try { await source.fetchFileInfoFromPath("a.txt"); throw new Error("Expected a failed probe"); }
      catch (error) { expect(error.message).to.equal("Forbidden"); }
      expect((await guards().findOne({ _id: secondKey })).state).to.equal("accepted");
      response = { type: "file", sha: "a".repeat(40), size: 11 };
      await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { "source.repositoryName": "different/source" } });
      await source.fetchFileInfoFromPath("a.txt");
      expect((await guards().findOne({ _id: secondKey })).state).to.equal("accepted");
    } finally { database.isConnected = originals.isConnected; utils.octokit = originals.octokit; }
  });
  it("resumes a migration after a startup crashed and its lease expired", async () => {
    await guards().insertOne({ _id: "recipient-alerts-v1", state: "new", lease: "crashed", leaseUntil: new Date(0) });
    await alerts.initializeOwnerAccessAlerts(); expect((await guards().findOne({ _id: "recipient-alerts-v1" })).state).to.equal("ready");
  });
  it("continues waiting beyond 300 polls while another migration holds a healthy lease", async () => {
    await guards().insertOne({ _id: "recipient-alerts-v1", state: "new", lease: "active-migration", leaseUntil: new Date(Date.now() + 600000) });
    const collection = guards(), update = collection.updateOne, timeout = global.setTimeout;
    let polls = 0;
    collection.updateOne = async function (filter, ...args) {
      if (filter._id === "recipient-alerts-v1" && filter.$or && ++polls === 305) {
        await update.call(this, { _id: "recipient-alerts-v1" }, { $set: { state: "ready" } });
      }
      return update.call(this, filter, ...args);
    };
    global.setTimeout = (callback, delay, ...args) => delay === 250 ? timeout(callback, 0, ...args) : timeout(callback, delay, ...args);
    try { await alerts.initializeOwnerAccessAlerts(); }
    finally { collection.updateOne = update; global.setTimeout = timeout; }
    expect(polls).to.equal(305);
    expect((await guards().findOne({ _id: "recipient-alerts-v1" })).state).to.equal("ready");
  });
});
