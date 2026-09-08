const process = require("process");
const { expect } = require("chai");
require("ts-node/register/transpile-only");
const mongoose = require("mongoose");
const { migrateCredentials, verifyCredentials, enforceCredentialStorage } = require("../src/core/migrate-credentials");
const { createTokenCipher } = require("../src/core/credential-crypto");

// Always use a newly named disposable database, never the database in the URI.
const describeMongo = process.env.TEST_MONGODB_URI ? describe : describe.skip;
describeMongo("credential migration (MongoDB)", function () {
  this.timeout(20000);
  let client, db, owner;
  const cipher = createTokenCipher(JSON.stringify({ test: Buffer.alloc(32, 7).toString("base64") }), "test");
  const apply = { apply: true, removeLegacy: true };
  before(async () => {
    client = new mongoose.mongo.MongoClient(process.env.TEST_MONGODB_URI);
    await client.connect();
    db = client.db(`credential_test_${new mongoose.Types.ObjectId()}`);
  });
  beforeEach(async () => {
    await db.dropDatabase();
    owner = new mongoose.Types.ObjectId();
    await db.collection("users").insertOne({ _id: owner, username: "test", accessTokens: { github: "secret" } });
  });
  after(async () => { if (db) await db.dropDatabase(); if (client) await client.close(); });
  it("dry run does not modify data", async () => {
    const result = await migrateCredentials(db, cipher);
    expect(result.created).to.equal(1);
    expect(await db.collection("credentials").countDocuments()).to.equal(0);
    expect((await db.collection("users").findOne({ _id: owner })).accessTokens.github).to.equal("secret");
  });
  it("encrypts once, cleans all legacy locations, and is safe to rerun", async () => {
    for (const name of ["anonymizedrepositories", "anonymizedgists", "anonymizedpullrequests"]) {
      await db.collection(name).insertOne({ owner, source: { accessToken: "secret" }, accessToken: "secret" });
    }
    const first = await migrateCredentials(db, cipher, apply);
    expect(first.issues).to.equal(0);
    const credential = await db.collection("credentials").findOne({ ownerId: owner });
    expect(JSON.stringify(credential)).not.to.include("secret");
    expect(cipher.decrypt(credential.encryptedToken, String(owner), "github")).to.equal("secret");
    expect(await verifyCredentials(db, cipher)).to.deep.equal({ checked: 1, legacy: 0 });
    expect((await migrateCredentials(db, cipher, apply)).created).to.equal(0);
    expect((await db.collection("credentials").findOne({ ownerId: owner })).encryptedToken).to.deep.equal(credential.encryptedToken);
  });
  it("reports resource conflicts without deleting either token", async () => {
    await db.collection("anonymizedgists").insertOne({ owner, source: { accessToken: "different" } });
    const events = [];
    const result = await migrateCredentials(db, cipher, { ...apply, report: e => events.push(e) });
    expect(result.issues).to.equal(1);
    expect(JSON.stringify(events)).not.to.include("different");
    expect(await db.collection("credentials").countDocuments()).to.equal(0);
    expect((await db.collection("users").findOne({ _id: owner })).accessTokens.github).to.equal("secret");
    expect((await migrateCredentials(db, cipher, { ...apply, preferOwnerToken: true })).issues).to.equal(0);
    expect(await verifyCredentials(db, cipher)).to.deep.equal({ checked: 1, legacy: 0 });
  });
  it("preserves a newer credential and requires explicit conflict resolution", async () => {
    const envelope = cipher.encrypt("new-login", String(owner), "github");
    await db.collection("credentials").insertOne({ ownerId: owner, provider: "github", encryptedToken: envelope, updatedAt: new Date() });
    expect((await migrateCredentials(db, cipher, apply)).issues).to.equal(1);
    await migrateCredentials(db, cipher, { ...apply, preferOwnerToken: true });
    expect((await db.collection("credentials").findOne({ ownerId: owner })).encryptedToken).to.deep.equal(envelope);
  });
  it("migrates resource-only credentials but never arbitrarily picks between them", async () => {
    await db.collection("users").updateOne({ _id: owner }, { $unset: { accessTokens: "" } });
    await db.collection("anonymizedgists").insertOne({ owner, source: { accessToken: "resource" } });
    await db.collection("anonymizedpullrequests").insertOne({ owner, source: { accessToken: "other" } });
    expect((await migrateCredentials(db, cipher, { ...apply, preferOwnerToken: true })).issues).to.equal(1);
    await db.collection("anonymizedpullrequests").deleteMany({});
    expect((await migrateCredentials(db, cipher, apply)).issues).to.equal(0);
    const row = await db.collection("credentials").findOne({ ownerId: owner });
    expect(cipher.decrypt(row.encryptedToken, String(owner), "github")).to.equal("resource");
  });
  it("reports missing owners and malformed tokens", async () => {
    await db.collection("anonymizedrepositories").insertOne({ source: { accessToken: "orphan" } });
    await db.collection("users").updateOne({ _id: owner }, { $set: { "accessTokens.github": { invalid: true } } });
    expect((await migrateCredentials(db, cipher, apply)).issues).to.equal(2);
    expect(await db.collection("credentials").countDocuments()).to.equal(0);
  });
  it("does not recreate credentials for removed accounts", async () => {
    await db.collection("users").updateOne({ _id: owner }, { $set: { status: "removed" } });
    expect((await migrateCredentials(db, cipher, apply)).issues).to.equal(0);
    expect(await verifyCredentials(db, cipher)).to.deep.equal({ checked: 0, legacy: 0 });
  });
  it("resumes after interruption between backfill and cleanup", async () => {
    await migrateCredentials(db, cipher, { apply: true });
    const envelope = (await db.collection("credentials").findOne({ ownerId: owner })).encryptedToken;
    expect((await verifyCredentials(db, cipher)).legacy).to.equal(1);
    await migrateCredentials(db, cipher, apply);
    expect(await verifyCredentials(db, cipher)).to.deep.equal({ checked: 1, legacy: 0 });
    expect((await db.collection("credentials").findOne({ ownerId: owner })).encryptedToken).to.deep.equal(envelope);
  });
  it("refuses cleanup when ciphertext cannot be authenticated", async () => {
    await migrateCredentials(db, cipher, { apply: true });
    await db.collection("credentials").updateOne({ ownerId: owner }, { $set: { "encryptedToken.tag": Buffer.alloc(16).toString("base64") } });
    expect((await migrateCredentials(db, cipher, apply)).issues).to.equal(1);
    expect((await db.collection("users").findOne({ _id: owner })).accessTokens.github).to.equal("secret");
  });
  it("enforces the unique owner/provider index", async () => {
    await migrateCredentials(db, cipher, apply);
    const row = await db.collection("credentials").findOne({ ownerId: owner });
    delete row._id;
    try { await db.collection("credentials").insertOne(row); throw new Error("expected duplicate"); }
    catch (error) { expect(error.code).to.equal(11000); }
  });
  it("enforces plaintext rejection in MongoDB after verification", async () => {
    await migrateCredentials(db, cipher, apply);
    await enforceCredentialStorage(db, cipher);
    try { await db.collection("users").updateOne({ _id: owner }, { $set: { "accessTokens.github": "bad" } }); throw new Error("expected rejection"); }
    catch (error) { expect(error.code).to.equal(121); }
    try { await db.collection("anonymizedgists").insertOne({ owner, source: { accessToken: "bad" } }); throw new Error("expected rejection"); }
    catch (error) { expect(error.code).to.equal(121); }
  });
});

describeMongo("credential access (MongoDB)", function () {
  this.timeout(20000);
  const config = require("../src/config").default;
  const Credential = require("../src/core/model/credentials/credentials.model").default;
  const UserModel = require("../src/core/model/users/users.model").default;
  const RepoModel = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
  const GistModel = require("../src/core/model/anonymizedGists/anonymizedGists.model").default;
  const PullModel = require("../src/core/model/anonymizedPullRequests/anonymizedPullRequests.model").default;
  const { setCredential, getCredentialToken, replaceCredential } = require("../src/core/credentials");
  let settings, owner;
  before(async () => {
    settings = [config.CREDENTIAL_KEYS, config.CREDENTIAL_ACTIVE_KEY_ID, config.CREDENTIAL_LEGACY_READS];
    config.CREDENTIAL_KEYS = JSON.stringify({ test: Buffer.alloc(32, 9).toString("base64") });
    config.CREDENTIAL_ACTIVE_KEY_ID = "test";
    config.CREDENTIAL_LEGACY_READS = false;
    await mongoose.connect(process.env.TEST_MONGODB_URI, { dbName: `credential_access_test_${new mongoose.Types.ObjectId()}` });
    await Credential.init();
  });
  beforeEach(async () => {
    await Credential.deleteMany({});
    owner = await UserModel.create({ username: `owner-${new mongoose.Types.ObjectId()}` });
  });
  after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    [config.CREDENTIAL_KEYS, config.CREDENTIAL_ACTIVE_KEY_ID, config.CREDENTIAL_LEGACY_READS] = settings;
  });
  it("persists only encrypted credentials and hides envelopes in ordinary queries", async () => {
    await setCredential(owner.id, "real-secret");
    const raw = await Credential.collection.findOne({ ownerId: owner._id });
    expect(raw.ownerId.equals(owner._id)).to.equal(true);
    expect(JSON.stringify(raw)).not.to.include("real-secret");
    expect((await Credential.findOne({ ownerId: owner._id })).encryptedToken).to.equal(undefined);
    expect(await getCredentialToken(owner.id)).to.equal("real-secret");
    expect((await UserModel.collection.findOne({ _id: owner._id })).accessTokens).to.equal(undefined);
  });
  it("handles simultaneous logins with one owner/provider row", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => setCredential(owner.id, `token-${i}`)));
    expect(await Credential.countDocuments({ ownerId: owner._id })).to.equal(1);
    expect(await getCredentialToken(owner.id)).to.match(/^token-\d$/);
  });
  it("updates the encrypted envelope atomically on refresh", async () => {
    await setCredential(owner.id, "previous");
    expect(await replaceCredential(owner.id, "previous", "next")).to.equal(true);
    expect(await replaceCredential(owner.id, "previous", "stale")).to.equal(false);
    expect(await getCredentialToken(owner.id)).to.equal("next");
  });
  it("resolves gists and pull requests by owner and observes token changes", async () => {
    const Gist = require("../src/core/Gist").default;
    const PullRequest = require("../src/core/PullRequest").default;
    const gist = new Gist(await GistModel.create({ owner: owner._id, source: { gistId: "test" } }));
    const pull = new PullRequest(await PullModel.create({ owner: owner._id, source: { pullRequestId: "1" } }));
    await setCredential(owner.id, "first");
    expect(await gist.getToken()).to.equal("first");
    expect(await pull.getToken()).to.equal("first");
    await setCredential(owner.id, "second");
    expect(await gist.getToken()).to.equal("second");
    expect(await pull.getToken()).to.equal("second");
    expect((await GistModel.collection.findOne({ _id: gist.model._id })).source.accessToken).to.equal(undefined);
    expect((await PullModel.collection.findOne({ _id: pull.model._id })).source.accessToken).to.equal(undefined);
  });
  it("refreshes a repository credential without copying it onto the repository", async () => {
    const Repository = require("../src/core/Repository").default;
    const repo = new Repository(await RepoModel.create({ owner: owner._id, repoId: "test-repo", source: { type: "GitHubStream" } }));
    await setCredential(owner.id, "old-token");
    await Credential.updateOne({ ownerId: owner._id }, { $set: { updatedAt: new Date(0) } });
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      expect(url).to.include("api.github.com/applications/");
      expect(JSON.parse(options.body).access_token).to.equal("old-token");
      return { ok: true, json: async () => ({ token: "refreshed-token" }) };
    };
    try { expect(await repo.getToken()).to.equal("refreshed-token"); }
    finally { global.fetch = originalFetch; }
    expect(await getCredentialToken(owner.id)).to.equal("refreshed-token");
    expect((await RepoModel.collection.findOne({ _id: repo.model._id })).source.accessToken).to.equal(undefined);
  });
  it("OAuth login writes a credential and returns a token-free session user", async () => {
    const passport = require("passport");
    require("../src/server/routes/connection");
    const result = await new Promise((resolve, reject) => passport._strategy("github")._verify("oauth-secret", "refresh-secret", {
      id: "external-test", username: owner.username, emails: [], photos: [],
    }, (error, user) => error ? reject(error) : resolve(user)));
    expect(JSON.stringify(result)).not.to.include("oauth-secret");
    expect(JSON.stringify(result)).not.to.include("refresh-secret");
    expect(await getCredentialToken(owner.id)).to.equal("oauth-secret");
    expect((await UserModel.collection.findOne({ _id: owner._id })).accessTokens).to.equal(undefined);
  });
  it("reads hidden legacy resource tokens only during compatibility mode", async () => {
    const resource = await GistModel.collection.insertOne({ gistId: "legacy-gist", owner: owner._id, source: { accessToken: "legacy-resource" } });
    const lookup = { collection: "anonymizedgists", id: resource.insertedId };
    expect(await getCredentialToken(owner.id, "github", lookup)).to.equal("");
    config.CREDENTIAL_LEGACY_READS = true;
    try {
      expect(await getCredentialToken(owner.id, "github", lookup)).to.equal("legacy-resource");
      await setCredential(owner.id, "encrypted-wins");
      expect(await getCredentialToken(owner.id, "github", lookup)).to.equal("encrypted-wins");
    } finally { config.CREDENTIAL_LEGACY_READS = false; }
  });
});
