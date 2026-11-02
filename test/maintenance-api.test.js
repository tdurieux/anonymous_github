const { expect } = require("chai");
require("ts-node/register/transpile-only");
const express = require("express");
const UserModel = require("../src/core/model/users/users.model").default;
const { bearerTokenAuth, hashToken, maintenanceTokenAllows } = require("../src/server/routes/token-auth");
const { maintenanceSettings } = require("../src/server/routes/maintenance");
const { router: connection } = require("../src/server/routes/connection");

describe("repository maintenance tokens", () => {
  let server, base, originalFind, originalUpdate, model, lookups, logins;
  before(async () => {
    originalFind = UserModel.findOne;
    originalUpdate = UserModel.updateOne;
    UserModel.findOne = async () => { lookups++; return model; };
    UserModel.updateOne = async () => ({ matchedCount: 1 });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // An existing cookie must not override the supplied restricted token.
      req.user = { username: "cookie-admin" };
      req.login = (_user, callback) => { logins++; callback(); };
      next();
    });
    app.use(bearerTokenAuth);
    app.use("/github", connection);
    app.use((_req, res) => res.json({ reached: true, scoped: !!res.locals.maintenanceToken }));
    server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(() => {
    lookups = logins = 0;
    model = { _id: "owner", username: "alice", status: "active", apiTokens: [{
      tokenHash: hashToken("secret"), scope: "repository-maintenance", repoIds: ["paper-123"],
      expiresAt: new Date(Date.now() + 60_000),
    }] };
  });
  after(async () => {
    UserModel.findOne = originalFind;
    UserModel.updateOne = originalUpdate;
    await new Promise(resolve => server.close(resolve));
  });
  const request = (path, method = "GET") => globalThis.fetch(base + path, {
    method, headers: { authorization: "Bearer secret" },
  });
  it("allows only the selected repository and explicit maintenance operations", async () => {
    for (const [path, method] of [
      ["/api/maintenance/repositories/paper-123", "GET"],
      ["/api/maintenance/repositories/paper-123", "PATCH"],
      ["/api/repo/paper-123/refresh", "POST"], ["/api/repo/paper-123/extend", "POST"],
    ]) {
      const response = await request(path, method);
      expect(response.status).to.equal(200);
      expect((await response.json()).scoped).to.equal(true);
    }
  });
  it("blocks downloads, previews, source replacement, token minting, and other repos", async () => {
    for (const [path, method] of [
      ["/api/repo/paper-123/file/README.md", "GET"], ["/api/repo/paper-123/zip", "GET"],
      ["/api/repo/owner/repository/readme", "GET"], ["/api/repo/paper-123", "POST"],
      ["/api/maintenance/repositories/another", "PATCH"], ["/api/repo/another/refresh", "POST"],
      ["/api/admin", "GET"], ["/api/user/maintenance-tokens", "POST"],
      ["/github/login-token", "POST"], ["/w/paper-123/", "GET"],
    ]) expect((await request(path, method)).status, path).to.equal(403);
  });
  it("rejects encoded scope bypasses and unexpected methods", () => {
    for (const path of ["/api/repo/paper%2D123/refresh", "/api/repo/paper-123/refresh/extra", "/api/repo/paper-123//refresh"]) {
      expect(maintenanceTokenAllows("POST", path, ["paper-123"])).to.equal(false);
    }
    expect(maintenanceTokenAllows("DELETE", "/api/maintenance/repositories/paper-123", ["paper-123"])).to.equal(false);
  });
  it("rejects expired, revoked, banned, and malformed scoped tokens despite a session", async () => {
    model.apiTokens[0].expiresAt = new Date(0);
    expect((await request("/api/repo/paper-123/refresh", "POST")).status).to.equal(401);
    model.apiTokens[0].expiresAt = undefined;
    expect((await request("/api/repo/paper-123/refresh", "POST")).status).to.equal(401);
    model.apiTokens[0].expiresAt = new Date(Date.now() + 60_000);
    model.status = "banned";
    expect((await request("/api/repo/paper-123/refresh", "POST")).status).to.equal(401);
    model = null;
    expect((await request("/api/repo/paper-123/refresh", "POST")).status).to.equal(401);
    expect(lookups).to.equal(4);
  });
  it("cannot exchange a maintenance token in a body for an unrestricted session", async () => {
    const response = await globalThis.fetch(base + "/github/login-token", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "secret" }) });
    expect(response.status).to.equal(401);
    expect(logins).to.equal(0);
  });
  it("rejects malformed authorization instead of falling back to a cookie", async () => {
    for (const authorization of ["Bearer", "Basic anything", "Bearer " + "x".repeat(513)]) {
      const response = await globalThis.fetch(base + "/api/admin", { headers: { authorization } });
      expect(response.status).to.equal(401);
    }
    expect(lookups).to.equal(0);
  });
  it("fails closed when authentication storage is unavailable", async () => {
    const find = UserModel.findOne;
    UserModel.findOne = async () => { throw new Error("database offline"); };
    try {
      const response = await request("/api/maintenance/repositories/paper-123");
      expect(response.status).to.equal(503);
      expect(await response.json()).to.deep.equal({ error: "authentication_unavailable" });
    } finally { UserModel.findOne = find; }
  });
  it("preserves legacy unrestricted admin tokens", async () => {
    delete model.apiTokens[0].scope;
    expect((await request("/api/admin")).status).to.equal(200);
  });
});

describe("maintenance settings patch", () => {
  it("preserves omitted fields and accepts explicit false and empty terms", () => {
    expect(maintenanceSettings({ terms: [], update: false })).to.deep.equal({
      "options.terms": [], "options.update": false,
    });
  });
  it("rejects source changes, arbitrary option paths, invalid types and oversized terms", () => {
    for (const body of [null, [], {}, { source: {} }, { "options.update": true },
      { image: "false" }, { terms: [1] }, { terms: [""] }, { terms: ["a".repeat(1001)] },
      { terms: Array(1001).fill("a") }, { pageSource: { branch: "other" } }]) {
      expect(() => maintenanceSettings(body)).to.throw("invalid_settings");
    }
  });
});

describe("maintenance routes enforce current membership", () => {
  const db = require("../src/server/database");
  const RepoModel = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
  const maintenance = require("../src/server/routes/maintenance").default;
  const tokens = require("../src/server/routes/maintenance-tokens").default;
  let server, base, originals, user, repo, writes, tokenWrite;
  before(async () => {
    originals = [UserModel.findById, UserModel.updateOne, db.getRepository, RepoModel.updateOne];
    UserModel.findById = async () => user;
    UserModel.updateOne = async (filter, update) => {
      tokenWrite = { filter, update };
      return { matchedCount: 1, modifiedCount: 1 };
    };
    db.getRepository = async () => repo;
    RepoModel.updateOne = (filter, update) => {
      writes.push({ filter, update });
      return { exec: async () => ({ matchedCount: 1 }) };
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { user };
      req.isAuthenticated = () => req.headers["x-session"] === "yes";
      next();
    });
    app.use("/api/maintenance", maintenance);
    app.use("/api/user/maintenance-tokens", tokens);
    server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(() => {
    user = new UserModel({ username: "alice", externalIDs: { github: "123" } });
    repo = { repoId: "paper-123", status: "ready", owner: { id: user.id },
      assertNotArchived() {}, model: { _id: "repo", status: "ready", statusDate: new Date(),
        source: { branch: "main", commit: "abc", accessToken: "never-return" },
        options: { terms: ["Alice"], image: true, pdf: true }, coauthors: [],
        githubAccess: { secret: "never-return" } } };
    writes = []; tokenWrite = null;
  });
  after(async () => {
    [UserModel.findById, UserModel.updateOne, db.getRepository, RepoModel.updateOne] = originals;
    await new Promise(resolve => server.close(resolve));
  });
  function call(path, method = "GET", body, headers = {}) {
    return globalThis.fetch(base + path, { method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined });
  }
  it("returns saved state without credentials and marks it uncacheable", async () => {
    const response = await call("/api/maintenance/repositories/paper-123");
    expect(response.status).to.equal(200);
    expect(response.headers.get("cache-control")).to.equal("no-store");
    const body = await response.json();
    expect(body.source).to.deep.equal({ branch: "main", commit: "abc" });
    expect(JSON.stringify(body)).not.to.include("never-return");
  });
  it("denies reads and writes after membership removal", async () => {
    repo.owner.id = "other-owner";
    for (const method of ["GET", "PATCH"]) {
      expect((await call("/api/maintenance/repositories/paper-123", method,
        method === "PATCH" ? { image: false } : undefined)).status).to.equal(403);
    }
    expect(writes).to.have.length(0);
  });
  it("lets coauthors patch individual options without replacing the source", async () => {
    repo.owner.id = "other-owner";
    repo.model.coauthors = [{ githubId: "123" }];
    const response = await call("/api/maintenance/repositories/paper-123", "PATCH", { image: false });
    expect(response.status).to.equal(200);
    expect(writes[0].update.$set["options.image"]).to.equal(false);
    expect(Object.keys(writes[0].update.$set)).to.deep.equal(["options.image", "settingsSavedAt"]);
    expect(writes[0].filter.status).to.equal("ready");
  });
  it("rejects settings changes while removal is underway", async () => {
    repo.status = "removing";
    expect((await call("/api/maintenance/repositories/paper-123", "PATCH", { image: false })).status).to.equal(409);
    expect(writes).to.have.length(0);
  });
  it("issues only hashed, bounded, scoped credentials from a session", async () => {
    const response = await call("/api/user/maintenance-tokens", "POST",
      { name: "client", repoIds: ["paper-123"] }, { "x-session": "yes" });
    expect(response.status).to.equal(201);
    const body = await response.json();
    expect(body.token).to.match(/^[a-f0-9]{64}$/);
    expect(tokenWrite.update.$push.apiTokens.tokenHash).to.equal(hashToken(body.token));
    expect(tokenWrite.update.$push.apiTokens.scope).to.equal("repository-maintenance");
    expect(tokenWrite.filter["apiTokens.50"]).to.deep.equal({ $exists: false });
    expect(body).not.to.have.property("tokenHash");
  });
  it("rejects token issuance without session, with bearer, or for unrelated repositories", async () => {
    const body = { name: "client", repoIds: ["paper-123"] };
    expect((await call("/api/user/maintenance-tokens", "POST", body)).status).to.equal(401);
    expect((await call("/api/user/maintenance-tokens", "POST", body,
      { "x-session": "yes", authorization: "Bearer anything" })).status).to.equal(401);
    repo.owner.id = "other-owner";
    expect((await call("/api/user/maintenance-tokens", "POST", body, { "x-session": "yes" })).status).to.equal(403);
    expect(tokenWrite).to.equal(null);
  });
  it("rejects token lifetimes above 90 days", async () => {
    expect((await call("/api/user/maintenance-tokens", "POST",
      { name: "client", repoIds: ["paper-123"], expiresInDays: 91 },
      { "x-session": "yes" })).status).to.equal(400);
    expect(tokenWrite).to.equal(null);
  });
  it("revokes only the signed-in account's maintenance token", async () => {
    const id = "507f1f77bcf86cd799439011";
    expect((await call(`/api/user/maintenance-tokens/${id}`, "DELETE", undefined,
      { "x-session": "yes" })).status).to.equal(200);
    expect(String(tokenWrite.filter._id)).to.equal(user.id);
    expect(tokenWrite.update.$pull.apiTokens).to.deep.equal({ _id: id, scope: "repository-maintenance" });
  });
});

describe("maintenance abuse limits", () => {
  const { rateLimit } = require("express-rate-limit");
  const { tokenAttemptLimitOptions, maintenanceRefreshLimitOptions } = require("../src/server/routes/maintenance-limits");
  let server, base, originals, lookups, model, reached;
  beforeEach(async () => {
    originals = [UserModel.findOne, UserModel.updateOne];
    UserModel.findOne = async () => { lookups++; return model; };
    UserModel.updateOne = async () => ({ matchedCount: 1 });
    const app = express();
    app.use(rateLimit({ ...tokenAttemptLimitOptions, limit: 8 }));
    app.use(bearerTokenAuth);
    app.use(rateLimit(maintenanceRefreshLimitOptions));
    app.use((_req, res) => { reached++; res.json({ ok: true }); });
    server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
    model = { _id: "owner", status: "active", apiTokens: ["one", "two"].map(token => ({
      tokenHash: hashToken(token), scope: "repository-maintenance", repoIds: ["paper-123", "Paper-123"],
      expiresAt: new Date(Date.now() + 60_000),
    })) };
    lookups = reached = 0;
  });
  afterEach(async () => {
    [UserModel.findOne, UserModel.updateOne] = originals;
    await new Promise(resolve => server.close(resolve));
  });
  it("shares refresh cooldown across tokens, casing and trailing slashes; allows polling", async () => {
    const call = (path, token, method = "POST") => globalThis.fetch(base + path, {
      method, headers: { authorization: `Bearer ${token}` },
    });
    expect((await call("/api/repo/paper-123/refresh", "one")).status).to.equal(200);
    const denied = await call("/api/repo/Paper-123/refresh/", "two");
    expect(denied.status).to.equal(429);
    expect(Number(denied.headers.get("retry-after"))).to.be.greaterThan(0);
    expect(await denied.json()).to.deep.equal({ error: "refresh_rate_limited" });
    expect((await call("/api/maintenance/repositories/paper-123", "two", "GET")).status).to.equal(200);
    // A removed coauthor's requests cannot consume another account's cooldown.
    model._id = "another-owner";
    expect((await call("/api/repo/paper-123/refresh", "one")).status).to.equal(200);
  });
  it("charges failed authentication before MongoDB and never reaches a route", async () => {
    model = null;
    const beforeRoutes = reached;
    for (let i = 0; i < 8; i++) {
      expect((await globalThis.fetch(base + "/api/admin", {
        headers: { authorization: "Bearer invalid" },
      })).status).to.equal(401);
    }
    const beforeLookups = lookups;
    const response = await globalThis.fetch(base + "/api/admin", {
      headers: { authorization: "Bearer invalid" },
    });
    expect(response.status).to.equal(429);
    expect(await response.json()).to.deep.equal({ error: "token_attempts_rate_limited" });
    expect(lookups).to.equal(beforeLookups);
    expect(reached).to.equal(beforeRoutes);
    // Anonymous review traffic does not use the bearer authentication budget.
    expect((await globalThis.fetch(base + "/")).status).to.equal(200);
  });
});
