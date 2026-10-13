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
    const id = new mongoose.Types.ObjectId(); await coll(kind).insertOne({ _id: id, owner: ownerId, status: "ready" }); return { kind, id: String(id) };
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
  it("does not reopen after reconnect alone, unrelated resource success, or failed recovery", async () => {
    await notify(owner.id, "token_expired", resource); await reset(owner.id);
    await recover(otherOwner.id, other, async () => {});
    try { await recover(owner.id, resource, async () => { throw new Error("Forbidden"); }); } catch { /* Expected. */ }
    await notify(owner.id, "token_expired", resource); await notify(otherOwner.id, "token_expired", other);
    expect(sent).to.have.length(1);
  });
  it("requires owner action before a successful upstream read can reopen the recipient", async () => {
    await notify(owner.id, "token_expired", resource);
    await recover(owner.id, resource, async () => {}); expect(await guards().findOne({ _id: recipient() })).not.to.equal(null);
    await reset(owner.id, resource); await recover(owner.id, resource, async () => {});
    expect(await guards().findOne({ _id: recipient() })).to.equal(null);
    await notify(owner.id, "token_expired", resource); expect(sent).to.have.length(2);
    expect(sent[0].headers["Idempotency-Key"]).not.to.equal(sent[1].headers["Idempotency-Key"]);
    expect(await mongoose.connection.collection("owner_access_alert_events").countDocuments()).to.equal(2);
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
    const collection = coll(resource.kind), update = collection.updateOne;
    let entered, release; const gate = new Promise(resolve => { entered = resolve; });
    collection.updateOne = async function (...args) { entered(); await new Promise(resolve => { release = resolve; }); return update.apply(this, args); };
    try {
      const pending = notify(owner.id, "token_expired", resource); await gate;
      await reset(owner.id, resource); await recover(owner.id, resource, async () => {});
      release(); await pending; expect(sent).to.have.length(0);
      expect(await guards().findOne({ _id: recipient() })).to.equal(null);
    } finally { collection.updateOne = update; }
  });
  it("fences a second owner action that races after recovery's final resource check", async () => {
    await notify(owner.id, "token_expired", resource); await reset(owner.id, resource);
    const collection = guards(), remove = collection.deleteOne;
    let entered, release; const gate = new Promise(resolve => { entered = resolve; });
    collection.deleteOne = async function (...args) { entered(); await new Promise(resolve => { release = resolve; }); return remove.apply(this, args); };
    try {
      const pending = recover(owner.id, resource, async () => {}); await gate;
      await reset(owner.id, resource); release(); await pending;
      expect(await guards().findOne({ _id: recipient() })).not.to.equal(null);
    } finally { collection.deleteOne = remove; }
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
  it("releases a guard for a removed resource without erasing delivery history", async () => {
    await notify(owner.id, "token_expired", resource);
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { status: "removed" } });
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(2);
    expect(await mongoose.connection.collection("owner_access_alert_events").countDocuments()).to.equal(2);
  });
  it("seeds old claims once while five instances start concurrently", async () => {
    await coll(resource.kind).updateOne({ _id: new mongoose.Types.ObjectId(resource.id) }, { $set: { accessAlertClaimedAt: new Date() } });
    await Promise.all(Array.from({ length: 5 }, () => alerts.initializeOwnerAccessAlerts()));
    expect((await guards().findOne({ _id: recipient() })).state).to.equal("legacy");
    await notify(otherOwner.id, "repo_not_found", other); expect(sent).to.have.length(0);
    await reset(owner.id, resource); await recover(owner.id, resource, async () => {});
    await alerts.initializeOwnerAccessAlerts(); expect(await guards().findOne({ _id: recipient() })).to.equal(null);
  });
  it("resumes a migration after a startup crashed and its lease expired", async () => {
    await guards().insertOne({ _id: "recipient-alerts-v1", state: "new", lease: "crashed", leaseUntil: new Date(0) });
    await alerts.initializeOwnerAccessAlerts(); expect((await guards().findOne({ _id: "recipient-alerts-v1" })).state).to.equal("ready");
  });
});
