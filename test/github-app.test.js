const { expect } = require("chai");
const { URL } = require("node:url");
const { createHmac, generateKeyPairSync, createVerify } = require("crypto");
const process = require("process");
const { setTimeout } = require("timers");
const express = require("express");
const mongoose = require("mongoose");
require("ts-node/register/transpile-only");
const config = require("../src/config").default;
const app = require("../src/core/github-app");
const { createTokenCipher } = require("../src/core/credential-crypto");
const { githubAppRouter, githubAppWebhook, validWebhookSignature, safeReturnTo, consumeFlow } = require("../src/server/routes/github-app");
const Credentials = require("../src/core/model/credentials/credentials.model").default;
const Users = require("../src/core/model/users/users.model").default;
const Installations = require("../src/core/model/github-installation").default;
const { getCredentialToken, setCredential } = require("../src/core/credentials");
const { verifyCredentials } = require("../src/core/migrate-credentials");
const { registerGitHubToken, githubQuotaKey } = require("../src/core/github-token-context");
const keys = JSON.stringify({ test: Buffer.alloc(32, 9).toString("base64") });
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });

async function rejects(promise, message) {
  try { await promise; } catch (error) { expect(error.message).to.equal(message); return; }
  throw new Error(`Expected rejection: ${message}`);
}

describe("GitHub App protocol boundaries", () => {
  it("uses a different authenticated purpose for refresh ciphertext", () => {
    const cipher = createTokenCipher(keys, "test");
    const access = cipher.encrypt("access", "owner", app.APP_PROVIDER);
    const refresh = cipher.encrypt("refresh", "owner", app.APP_PROVIDER, "encryptedRefreshToken");
    expect(cipher.decrypt(refresh, "owner", app.APP_PROVIDER, "encryptedRefreshToken")).to.equal("refresh");
    expect(() => cipher.decrypt(access, "owner", app.APP_PROVIDER, "encryptedRefreshToken")).to.throw();
    expect(() => cipher.decrypt(refresh, "owner", app.APP_PROVIDER)).to.throw();
  });
  it("validates raw webhook bytes and rejects malformed signatures", () => {
    const raw = Buffer.from('{"action":"deleted"}');
    const signature = "sha256=" + createHmac("sha256", "secret").update(raw).digest("hex");
    expect(validWebhookSignature(raw, signature, "secret")).to.equal(true);
    expect(validWebhookSignature(Buffer.from('{}'), signature, "secret")).to.equal(false);
    for (const value of [undefined, "sha256=aa", [], signature.replace("sha256", "sha1")]) {
      expect(validWebhookSignature(raw, value, "secret")).to.equal(false);
    }
  });
  it("restricts callback destinations and expires state", () => {
    for (const path of ["https://evil.test", "//evil.test", "/\\evil.test", "/anonymize\r\nLocation: x"]) {
      expect(safeReturnTo(path)).to.equal("/connections");
    }
    expect(safeReturnTo("/anonymize/saved")).to.equal("/anonymize/saved");
    expect(() => consumeFlow({ state: "secret", expires: Date.now() - 1 }, "secret")).to.throw("invalid_auth_state");
    expect(() => consumeFlow({ state: "secret", expires: Date.now() + 1000 }, "wrong")).to.throw("invalid_auth_state");
  });
  it("preselects known repositories without defaulting to all repositories", () => {
    const url = new globalThis.URL(app.installationURL(123, [456, 789]));
    expect(url.pathname).to.match(/\/installations\/new\/permissions$/);
    expect(url.searchParams.getAll("repository_ids[]")).to.deep.equal(["456", "789"]);
    expect(app.installationURL(123, [])).not.to.include("/permissions");
  });
  it("renews a rejected installation token once without using OAuth", async () => {
    const previousFetch = globalThis.fetch;
    const sent = [];
    let current = "ghs_before";
    registerGitHubToken("ghs_original", { quotaKey: "installation:renew", renew: async force => {
      if (force) current = "ghs_after";
      return current;
    } });
    globalThis.fetch = async (_url, options) => {
      sent.push(new globalThis.Headers(options.headers).get("authorization"));
      return new globalThis.Response(JSON.stringify(sent.length === 1 ? { message: "Bad credentials" } : { id: 1 }), {
        status: sent.length === 1 ? 401 : 200, headers: { "content-type": "application/json" },
      });
    };
    try {
      const { octokit } = require("../src/core/GitHubUtils");
      const response = await octokit("ghs_original").request("GET /repos/owner/private");
      expect(response.data.id).to.equal(1);
      expect(sent).to.deep.equal(["token ghs_before", "token ghs_after"]);
    } finally { globalThis.fetch = previousFetch; }
  });

  it("signs a short-lived App JWT with clock skew", () => {
    const previous = { enabled: config.GITHUB_APP_ENABLED, key: config.GITHUB_APP_PRIVATE_KEY, client: config.GITHUB_APP_CLIENT_ID };
    Object.assign(config, { GITHUB_APP_ENABLED: true, GITHUB_APP_PRIVATE_KEY: pem, GITHUB_APP_CLIENT_ID: "Iv.test" });
    try {
      const jwt = app.appJWT(1000000);
      const [header, payload, signature] = jwt.split(".");
      const body = JSON.parse(Buffer.from(payload, "base64url"));
      expect(body).to.deep.equal({ iat: 940, exp: 1540, iss: "Iv.test" });
      expect(createVerify("RSA-SHA256").update(header + "." + payload).verify(publicKey, signature, "base64url")).to.equal(true);
    } finally {
      Object.assign(config, { GITHUB_APP_ENABLED: previous.enabled, GITHUB_APP_PRIVATE_KEY: previous.key, GITHUB_APP_CLIENT_ID: previous.client });
    }
  });
});

const describeMongo = process.env.TEST_MONGODB_URI ? describe : describe.skip;
describeMongo("GitHub App credential and repository integration", function () {
  this.timeout(15000);
  let owner, previousConfig, previousFetch, calls, server, base, session, authenticated;
  const data = (suffix = "1", expires = 3600) => ({ access_token: "ghu_access" + suffix, refresh_token: "ghr_refresh" + suffix,
    expires_in: expires, refresh_token_expires_in: 100000 });
  before(async () => {
    previousConfig = { ...config };
    Object.assign(config, { GITHUB_APP_ENABLED: true, GITHUB_APP_ID: "123", GITHUB_APP_CLIENT_ID: "Iv.test",
      GITHUB_APP_PRIVATE_KEY: pem, CREDENTIAL_KEYS: keys, CREDENTIAL_ACTIVE_KEY_ID: "test" });
    await mongoose.connect(process.env.TEST_MONGODB_URI, { dbName: "github_app_test_" + Date.now() });
    await Credentials.createIndexes();
    await Installations.createIndexes();
    const api = express();
    api.use("/github/app/webhook", githubAppWebhook);
    api.use(express.json());
    api.use((req, _res, next) => {
      req.session = session;
      req.session.regenerate = done => done();
      req.user = authenticated ? { user: owner } : undefined;
      req.isAuthenticated = () => authenticated;
      req.login = (identity, done) => { req.user = identity; done(); };
      req.logout = done => done();
      next();
    });
    api.use("/github", githubAppRouter);
    api.use("/github", require("../src/server/routes/connection").router);
    server = await new Promise(resolve => { const listening = api.listen(0, "127.0.0.1", () => resolve(listening)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    globalThis.fetch = previousFetch;
    await new Promise(resolve => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    Object.assign(config, previousConfig);
  });
  beforeEach(async () => {
    previousFetch = globalThis.fetch;
    session = { save: done => done(), githubConnectionCSRF: "csrf-test" };
    calls = [];
    await Credentials.deleteMany({}); await Users.deleteMany({}); await Installations.deleteMany({});
    app.clearAppTokenCache();
    authenticated = true;
    owner = await Users.create({ username: "owner", externalIDs: { github: "10" } });
  });
  afterEach(() => { globalThis.fetch = previousFetch; });
  function mock(handler) {
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith(base)) return previousFetch(url, options);
      const body = options?.body ? JSON.parse(options.body) : undefined;
      calls.push({ url: String(url), body, options });
      const result = await handler(String(url), options, body);
      return new globalThis.Response(JSON.stringify(result.body || result), { status: result.status || 200, headers: { "content-type": "application/json" } });
    };
  }
  it("keeps OAuth and App grants separate, encrypted and migration-verifiable", async () => {
    await setCredential(owner.id, "legacy-secret");
    await app.saveAppGrant(owner.id, data());
    expect(await getCredentialToken(owner.id)).to.equal("legacy-secret");
    expect(await app.appUserToken(owner.id)).to.equal("ghu_access1");
    const raw = await mongoose.connection.db.collection("credentials").find({}).toArray();
    expect(JSON.stringify(raw)).not.to.include("ghr_refresh1");
    expect(JSON.stringify(raw)).not.to.include("ghu_access1");
    const projected = await Credentials.findOne({ ownerId: owner.id, provider: app.APP_PROVIDER }).lean();
    expect(projected.encryptedRefreshToken).to.equal(undefined);
    expect(projected.encryptedToken).to.equal(undefined);
    expect(await verifyCredentials(mongoose.connection.db, createTokenCipher(keys, "test"))).to.deep.equal({ checked: 2, legacy: 0 });
  });
  it("serializes refresh and atomically rotates the token pair", async () => {
    await app.saveAppGrant(owner.id, data("old", -1));
    mock(async (_url, _options, body) => {
      expect(body.refresh_token).to.equal("ghr_refreshold");
      await new Promise(resolve => setTimeout(resolve, 30));
      return data("new");
    });
    const tokens = await Promise.all([app.appUserToken(owner.id), app.appUserToken(owner.id)]);
    expect(tokens).to.deep.equal(["ghu_accessnew", "ghu_accessnew"]);
    expect(calls).to.have.length(1);
    const row = await Credentials.findOne({ ownerId: owner.id, provider: app.APP_PROVIDER }).select("+encryptedRefreshToken").lean();
    expect(createTokenCipher(keys, "test").decrypt(row.encryptedRefreshToken, owner.id, app.APP_PROVIDER, "encryptedRefreshToken")).to.equal("ghr_refreshnew");
  });
  it("does not overwrite a login that races a refresh", async () => {
    await app.saveAppGrant(owner.id, data("old", -1));
    mock(async () => { await app.saveAppGrant(owner.id, data("login")); return data("stale"); });
    expect(await app.appUserToken(owner.id)).to.equal("ghu_accesslogin");
  });
  it("does not revive revoked grants or disabled users", async () => {
    await app.saveAppGrant(owner.id, data());
    await Credentials.updateOne({ ownerId: owner.id }, { $set: { revoked: true } });
    await rejects(app.appUserToken(owner.id), "github_app_reconnect_required");
    await app.saveAppGrant(owner.id, data());
    await Users.updateOne({ _id: owner._id }, { $set: { status: "banned" } });
    await rejects(app.appUserToken(owner.id), "github_app_reconnect_required");
  });
  it("never falls back to OAuth when an App cannot access the repository", async () => {
    await setCredential(owner.id, "legacy-secret"); await app.saveAppGrant(owner.id, data());
    mock(() => ({ installations: [] }));
    await rejects(app.selectRepositoryAccess(owner.id, "owner/private"), "github_app_access_required");
    const selected = await app.selectRepositoryAccess(owner.id, "owner/private", "oauth");
    expect(selected.token).to.equal("legacy-secret");
    expect(selected.binding.kind).to.equal("oauth");
  });
  it("checks the user's access before minting a repository-restricted token", async () => {
    await app.saveAppGrant(owner.id, data());
    const binding = { kind: "github-app", installationId: 4, repositoryId: 7, revision: "one" };
    mock((url) => {
      if (url.endsWith("/repositories/7")) return { id: 7 };
      if (url.endsWith("/app/installations/4")) return { app_id: 123, permissions: { metadata: "read", contents: "read", pull_requests: "read" }, suspended_at: null };
      if (url.endsWith("/access_tokens")) return { token: "ghs_installation", expires_at: new Date(Date.now() + 3600000).toISOString() };
      throw new Error("Unexpected request");
    });
    expect(await app.boundAppToken(owner.id, binding)).to.equal("ghs_installation");
    const mint = calls.find(c => c.url.endsWith("/access_tokens"));
    expect(mint.body.repository_ids).to.deep.equal([7]);
    expect(Object.values(mint.body.permissions)).to.deep.equal(["read", "read", "read"]);
    expect(githubQuotaKey("ghs_installation")).to.equal("installation:4");
    expect(calls[0].options.headers.Authorization).to.equal("Bearer ghu_access1");
    await app.boundAppToken(owner.id, binding);
    expect(calls.filter(c => c.url.endsWith("/access_tokens"))).to.have.length(1);
    expect(calls.filter(c => c.url.endsWith("/repositories/7"))).to.have.length(2);
  });
  it("denies forged installations and grants with write permissions", async () => {
    await app.saveAppGrant(owner.id, data());
    const binding = { kind: "github-app", installationId: 4, repositoryId: 7, revision: "one" };
    mock(url => url.endsWith("/repositories/7") ? { id: 7 } : { app_id: 999, permissions: { contents: "read" } });
    await rejects(app.boundAppToken(owner.id, binding), "github_app_access_required");
    mock(url => url.endsWith("/repositories/7") ? { id: 7 } : { app_id: 123, permissions: { contents: "read", issues: "write" } });
    await rejects(app.boundAppToken(owner.id, binding), "github_app_permissions_invalid");
    expect(calls.some(c => c.url.endsWith("/access_tokens"))).to.equal(false);
  });
  it("blocks removed user access even if an installation token was cached", async () => {
    await app.saveAppGrant(owner.id, data());
    mock(() => ({ status: 404, body: { message: "private secret details" } }));
    await rejects(app.boundAppToken(owner.id, { kind: "github-app", installationId: 4, repositoryId: 7, revision: "one" }), "github_app_access_required");
    expect(calls).to.have.length(1);
  });
  async function request(path, body, csrf = "csrf-test") {
    const response = await previousFetch(base + path, { method: body ? "POST" : "GET", redirect: "manual",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, location: response.headers.get("location"), data: await response.json().catch(() => null) };
  }
  it("links App authorization to the existing OAuth account without replacing its grant", async () => {
    await setCredential(owner.id, "legacy-secret");
    owner.isAdmin = true; await owner.save();
    session.githubAppFlow = { state: "state", ownerId: owner.id, expires: Date.now() + 60000, returnTo: "/anonymize" };
    mock(url => url.includes("/login/oauth/access_token") ? data() : { id: 10, login: "owner" });
    const result = await request("/github/app/callback?state=state&code=code");
    expect(result.status).to.equal(302);
    expect(result.location).to.equal("/anonymize");
    expect(await Users.countDocuments()).to.equal(1);
    expect((await Users.findById(owner.id)).isAdmin).to.equal(true);
    expect(await getCredentialToken(owner.id)).to.equal("legacy-secret");
    expect(await app.appUserToken(owner.id)).to.equal("ghu_access1");
    expect(session.githubAppFlow).to.equal(undefined);
    const replay = await request("/github/app/callback?state=state&code=code");
    expect(replay.status).to.equal(400);
    expect(calls).to.have.length(2);
  });
  it("signs an existing user in through the App without changing legacy access", async () => {
    authenticated = false;
    await setCredential(owner.id, "legacy-secret");
    session.githubAppFlow = { state: "state", expires: Date.now() + 60000, returnTo: "/dashboard" };
    mock(url => url.includes("/login/oauth/access_token") ? data() : { id: 10, login: "owner-renamed" });
    const result = await request("/github/app/callback?state=state&code=code");
    expect(result.location).to.equal("/dashboard");
    expect(await Users.countDocuments()).to.equal(1);
    expect(await getCredentialToken(owner.id)).to.equal("legacy-secret");
    expect(await app.appUserToken(owner.id)).to.equal("ghu_access1");
  });
  it("requires legacy verification for an older account before linking its GitHub ID", async () => {
    authenticated = false;
    await Users.updateOne({ _id: owner._id }, { $unset: { externalIDs: 1 } });
    session.githubAppFlow = { state: "state", expires: Date.now() + 60000, returnTo: "/gist-anonymize" };
    mock(url => url.includes("/login/oauth/access_token") ? data() : { id: 10, login: "owner" });
    const result = await request("/github/app/callback?state=state&code=code");
    expect(result.location).to.equal("/signin?recover=1");
    expect(session.githubRecovery.ownerId).to.equal(owner.id);
    expect(session.githubRecovery.githubId).to.equal("10");
    expect(await Credentials.countDocuments()).to.equal(0);
    expect((await Users.findById(owner.id)).externalIDs?.github).to.equal(undefined);
    const { verify } = require("../src/server/routes/connection");
    const identity = await new Promise((resolve, reject) => verify({ githubOAuthContext: session.githubRecovery },
      "verified-legacy", "", { id: "10", username: "owner" }, (error, user) => error ? reject(error) : resolve(user)));
    expect(identity.user.id).to.equal(owner.id);
    expect((await Users.findById(owner.id)).externalIDs.github).to.equal("10");
    expect(await getCredentialToken(owner.id)).to.equal("verified-legacy");
  });
  it("returns OAuth connections to the gist form and rejects callback replay", async () => {
    const strategy = require("passport")._strategy("github");
    const exchange = strategy._oauth2.getOAuthAccessToken;
    const profile = strategy.userProfile;
    strategy._oauth2.getOAuthAccessToken = (_code, _params, done) => done(null, "gist-oauth", "", {});
    strategy.userProfile = (_token, done) => done(null, { id: "10", username: "owner" });
    try {
      const start = await request("/github/login?returnTo=%2Fgist-anonymize%2Fsaved");
      const state = new URL(start.location).searchParams.get("state");
      const result = await request("/github/auth?code=test&state=" + state);
      expect(result.location).to.equal("/gist-anonymize/saved");
      expect(await getCredentialToken(owner.id)).to.equal("gist-oauth");
      expect((await request("/github/auth?code=test&state=" + state)).location).to.equal("/signin");
      await request("/github/login?returnTo=https%3A%2F%2Fevil.test");
      expect(session.githubOAuthFlow.returnTo).to.equal("/connections");
    } finally {
      strategy._oauth2.getOAuthAccessToken = exchange;
      strategy.userProfile = profile;
    }
  });
  it("rejects a different account during OAuth recovery before saving credentials", async () => {
    const { verify } = require("../src/server/routes/connection");
    await rejects(new Promise((resolve, reject) => verify({ githubOAuthContext: { ownerId: owner.id, githubId: "10", expires: Date.now() + 60000 } },
      "wrong-token", "", { id: "99", username: "owner" }, (error, user) => error ? reject(error) : resolve(user))), "github_identity_mismatch");
    expect(await Credentials.countDocuments()).to.equal(0);
    expect((await Users.findById(owner.id)).externalIDs.github).to.equal("10");
  });
  it("rejects linking a different GitHub identity", async () => {
    session.githubAppFlow = { state: "state", ownerId: owner.id, expires: Date.now() + 60000, returnTo: "/connections" };
    mock(url => url.includes("/login/oauth/access_token") ? data() : { id: 99, login: "other" });
    const result = await request("/github/app/callback?state=state&code=code");
    expect(result.status).to.equal(409);
    expect(await Credentials.countDocuments()).to.equal(0);
    expect(await Users.countDocuments()).to.equal(1);
  });
  it("migrates only the owner's resource after checking its configured commit", async () => {
    const Repos = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
    await app.saveAppGrant(owner.id, data());
    const resource = await Repos.create({ repoId: "migration-resource", owner: owner.id, status: "ready",
      source: { type: "GitHubStream", repositoryName: "owner/private", commit: "abc123", branch: "main" },
      options: { terms: ["owner"], update: true } });
    mock(url => {
      if (url.includes("/user/installations?")) return { installations: [{ id: 4, app_id: 123, account: { id: 10, login: "owner", type: "User" } }] };
      if (url.includes("/user/installations/4/repositories")) return { repositories: [{ id: 7, full_name: "owner/private" }] };
      if (url.endsWith("/repositories/7")) return { id: 7 };
      if (url.endsWith("/app/installations/4")) return { app_id: 123, permissions: { contents: "read", metadata: "read" } };
      if (url.endsWith("/access_tokens")) return { token: "ghs_migration", expires_at: new Date(Date.now() + 3600000).toISOString() };
      if (url.endsWith("/commits/abc123")) return { sha: "abc123" };
      throw new Error("Unexpected request");
    });
    const body = { type: "repository", id: resource.repoId, connection: "github-app" };
    expect((await request("/github/connections/migrate", body, "bad")).status).to.equal(403);
    expect((await request("/github/connections/migrate", { ...body, preview: true })).status).to.equal(200);
    expect((await Repos.findById(resource.id)).githubAccess).to.equal(undefined);
    expect((await request("/github/connections/migrate", body)).status).to.equal(200);
    const migrated = await Repos.findById(resource.id);
    expect(migrated.githubAccess.kind).to.equal("github-app");
    expect(migrated.source.toObject()).to.deep.equal(resource.source.toObject());
    expect(migrated.options.terms).to.deep.equal(["owner"]);
    expect(migrated.repoId).to.equal("migration-resource");
    expect(calls.some(c => c.url.endsWith("/commits/abc123"))).to.equal(true);
    const stranger = await Users.create({ username: "stranger", externalIDs: { github: "11" } });
    owner = stranger;
    expect((await request("/github/connections/migrate", body)).status).to.equal(404);
  });
  it("checks repository access with signed lifecycle events and rejects forged deliveries", async () => {
    config.GITHUB_APP_WEBHOOK_SECRET = "webhook-secret";
    const body = JSON.stringify({ action: "deleted", installation: { id: 4, app_id: 123 } });
    const send = signature => previousFetch(base + "/github/app/webhook", { method: "POST", body,
      headers: { "Content-Type": "application/json", "X-GitHub-Event": "installation", "X-Hub-Signature-256": signature } });
    expect((await send("sha256=aa")).status).to.equal(401);
    const signature = "sha256=" + createHmac("sha256", "webhook-secret").update(body).digest("hex");
    expect((await send(signature)).status).to.equal(204);
    expect((await send(signature)).status).to.equal(204);
    expect((await Installations.findOne({ installationId: 4 })).blocked).to.equal(true);
    expect(await Installations.countDocuments()).to.equal(1);
  });

  async function webhook(event, payload) {
    config.GITHUB_APP_WEBHOOK_SECRET = "webhook-secret";
    const body = JSON.stringify(payload);
    return previousFetch(base + "/github/app/webhook", { method: "POST", body,
      headers: { "Content-Type": "application/json", "X-GitHub-Event": event,
        "X-Hub-Signature-256": "sha256=" + createHmac("sha256", "webhook-secret").update(body).digest("hex") } });
  }

  it("recovers a failed installation webhook on subsequent repository access", async () => {
    await app.saveAppGrant(owner.id, data());
    let unavailable = true;
    mock(url => {
      if (url.endsWith("/repositories/7")) return { id: 7 };
      if (url.endsWith("/access_tokens")) return { token: "ghs_recovered", expires_at: new Date(Date.now() + 3600000).toISOString() };
      if (unavailable) return { status: 503, body: {} };
      return { id: 4, app_id: 123, account: { id: 10, login: "owner", type: "User" }, permissions: { contents: "read" } };
    });
    expect((await webhook("installation_repositories", { action: "added", installation: { id: 4, app_id: 123 } })).status).to.equal(503);
    expect((await Installations.findOne({ installationId: 4 })).reconciliationPending).to.equal(true);
    unavailable = false;
    expect(await app.boundAppToken(owner.id, { kind: "github-app", repositoryId: 7, installationId: 4, revision: "r" })).to.equal("ghs_recovered");
    expect((await Installations.findOne({ installationId: 4 })).blocked).to.equal(false);
  });

  it("does not let an in-flight installation check undo a deletion", async () => {
    await Installations.create({ appId: "123", installationId: 4, revision: "old", blocked: true, reconciliationPending: true });
    mock(async () => {
      await webhook("installation", { action: "deleted", installation: { id: 4, app_id: 123 } });
      return { id: 4, app_id: 123, account: { id: 10, login: "owner", type: "User" } };
    });
    await app.reconcileInstallation(4, "old");
    expect((await Installations.findOne({ installationId: 4 })).blocked).to.equal(true);
  });

  it("reconciles replayed revocations without revoking a new working grant", async () => {
    const payload = { action: "revoked", sender: { id: 10 } };
    await app.saveAppGrant(owner.id, data());
    mock(() => ({ status: 401, body: {} }));
    expect((await webhook("github_app_authorization", payload)).status).to.equal(204);
    expect((await Credentials.findOne({ ownerId: owner.id })).revoked).to.equal(true);
    await app.saveAppGrant(owner.id, data("new"));
    mock(() => ({ id: 10 }));
    expect((await webhook("github_app_authorization", payload)).status).to.equal(204);
    expect((await Credentials.findOne({ ownerId: owner.id })).revoked).to.equal(false);
    mock(async () => {
      await app.saveAppGrant(owner.id, data("racing"));
      return { status: 401, body: {} };
    });
    await webhook("github_app_authorization", payload);
    expect((await Credentials.findOne({ ownerId: owner.id })).revoked).to.equal(false);
  });

  it("leaves the current grant intact when revocation reconciliation is unavailable", async () => {
    await app.saveAppGrant(owner.id, data("expired", -1));
    mock(() => ({ status: 503, body: {} }));
    expect((await webhook("github_app_authorization", { action: "revoked", sender: { id: 10 } })).status).to.equal(503);
    expect((await Credentials.findOne({ ownerId: owner.id })).revoked).to.equal(false);
  });

  it("rejects a stale source edit before clearing files or changing status", async () => {
    const Repos = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
    const Repository = require("../src/core/Repository").default;
    const model = await Repos.create({ repoId: "edit-race", owner: owner.id, status: "ready",
      githubAccess: { kind: "oauth", revision: "old" } });
    const repo = new Repository(model);
    let cleared = false;
    repo.resetSate = async () => { cleared = true; };
    await Repos.updateOne({ _id: model._id }, { $set: { githubAccess: { kind: "github-app", revision: "new", repositoryId: 7, installationId: 4 } } });
    await rejects(repo.remove({ accessRevision: "old" }), "connection_changed");
    expect(cleared).to.equal(false);
    expect((await Repos.findById(model._id)).status).to.equal("ready");
  });

});
