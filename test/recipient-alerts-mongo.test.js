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
    expect(await mongoose.connection.collection("owner_access_alert_events").countDocuments()).to.equal(4);
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
    expect(await mongoose.connection.collection("owner_access_alert_events").countDocuments()).to.equal(4);
  });
  for (const step of ["resource update", "resource verification", "audit insertion", "dispatch transition"]) it(`releases an unsent guard after ${step} fails`, async () => {
    const collection = step.startsWith("resource") ? coll(resource.kind) : step === "audit insertion" ? mongoose.connection.collection("owner_access_alert_events") : guards();
    const method = step === "resource verification" ? "findOne" : step === "audit insertion" ? "insertOne" : "updateOne";
    const original = collection[method]; let calls = 0;
    collection[method] = async function (...args) {
      calls++;
      if ((step === "resource verification" && calls === 2) || step !== "resource verification") throw new Error("transient database error");
      return original.apply(this, args);
    };
    try { await notify(owner.id, "token_expired", resource); }
    finally { collection[method] = original; }
    expect(sent).to.have.length(0); expect(await guards().findOne({ _id: recipient() })).to.equal(null);
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
  it("allows active accounts to receive alerts when a shared-address guard belongs to a banned owner", async () => {
    await notify(owner.id, "token_expired", resource);
    await Users.updateOne({ _id: owner._id }, { $set: { status: "banned" } });
    await notify(otherOwner.id, "token_expired", other); expect(sent).to.have.length(2);
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
      (await read()).destroy(); expect(await guards().findOne({ _id: recipient() })).to.equal(null);
      await notify(owner.id, "token_expired", resource); await reset(owner.id, resource);
      (await read()).destroy(); expect(await guards().findOne({ _id: recipient() })).not.to.equal(null);
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
      expect(await guards().findOne({ _id: recipient() })).to.equal(null);
    } finally { github.getRepositoryFromGitHub = original; }
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
