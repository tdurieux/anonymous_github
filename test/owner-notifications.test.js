const { expect } = require("chai");
require("ts-node/register/transpile-only");
const config = require("../src/config").default;
const User = require("../src/core/model/users/users.model").default;
const notifications = require("../src/core/owner-notifications");
const { normalizeEmail, notificationEmail, notifyOwnerAccessProblem } = notifications;

describe("owner access notifications", () => {
  const restores = [];
  const stub = (object, key, value) => { const old = object[key]; restores.push(() => object[key] = old); object[key] = value; };
  const ownerId = "507f1f77bcf86cd799439011";
  const resource = { kind: "repository", id: "507f1f77bcf86cd799439012" };
  const other = { kind: "repository", id: "507f1f77bcf86cd799439013" };
  let owner, sent, claims, rows;
  beforeEach(() => {
    owner = { status: "active", emails: [{ email: "owner@example.com", default: true }] };
    sent = []; claims = []; rows = new Map();
    stub(config, "RESEND_API_KEY", "test-resend-key");
    stub(config, "EMAIL_FROM", "alerts@example.com");
    stub(config, "APP_HOSTNAME", "anonymous.example.com");
    stub(User, "findOne", () => ({ lean: async () => ["removed", "banned"].includes(owner?.status) ? null : owner }));
    Object.defineProperty(User.db, "readyState", { configurable: true, value: 1 });
    restores.push(() => { delete User.db.readyState; });
    stub(User.db, "collection", name => ({
      updateOne: async (filter, update) => {
        claims.push(filter);
        const key = `${name}:${filter.owner}:${filter._id}`;
        if (rows.has(key)) return { modifiedCount: 0 };
        rows.set(key, update.$set.accessAlertClaimedAt);
        return { modifiedCount: 1 };
      },
      updateMany: async filter => {
        for (const key of rows.keys()) if (key.startsWith(`${name}:${filter.owner}:`) && (!filter._id || key.endsWith(`:${filter._id}`))) rows.delete(key);
      },
    }));
    stub(global, "fetch", async (url, options) => { sent.push({ url, options, body: JSON.parse(options.body) }); return { ok: true }; });
  });
  afterEach(() => { while (restores.length) restores.pop()(); });

  it("accepts one mailbox and rejects recipient lists and header injection", () => {
    expect(normalizeEmail(" Owner+alerts@example.com ")).to.equal("Owner+alerts@example.com");
    for (const value of [undefined, {}, "a@b.com,b@b.com", "Person <a@b.com>", "a@b.com\r\nBcc: x@y.com", ".a@b.com", "a..b@b.com", "a".repeat(65) + "@example.com"]) {
      expect(normalizeEmail(value)).to.equal(null);
    }
    expect(notificationEmail([{ email: "first@example.com", default: false }, { email: "primary@example.com", default: true }])).to.equal("primary@example.com");
  });

  it("sends once per resource across concurrent readers and repeated errors, with no time expiry", async () => {
    await Promise.all(Array.from({ length: 10 }, () => notifyOwnerAccessProblem(ownerId, "token_expired", resource)));
    expect(sent).to.have.length(1);
    for (const key of rows.keys()) rows.set(key, new Date("2000-01-01"));
    await notifyOwnerAccessProblem(ownerId, "repo_not_found", resource);
    expect(sent).to.have.length(1);
    await notifyOwnerAccessProblem(ownerId, "repo_not_found", other);
    expect(sent).to.have.length(2);
    expect(sent[0].url).to.equal("https://api.resend.com/emails");
    expect(sent[0].body.to).to.deep.equal(["owner@example.com"]);
    expect(sent[0].body.text).to.include("https://anonymous.example.com/connections");
    expect(claims[0].accessAlertClaimedAt).to.deep.equal({ $exists: false });
  });

  it("owner action resets only the selected resource and cannot reset another owner's alerts", async () => {
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    await notifyOwnerAccessProblem(ownerId, "token_expired", other);
    await notifications.resetOwnerAccessAlerts("507f1f77bcf86cd799439099", resource);
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    expect(sent).to.have.length(2);
    await notifications.resetOwnerAccessAlerts(ownerId, resource);
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    await notifyOwnerAccessProblem(ownerId, "token_expired", other);
    expect(sent).to.have.length(3);
  });

  it("reconnecting resets all of the owner's resource types", async () => {
    const resources = [resource, { ...resource, kind: "pull-request" }, { ...resource, kind: "gist" }];
    for (const item of resources) await notifyOwnerAccessProblem(ownerId, "token_expired", item);
    expect(sent).to.have.length(3);
    await notifications.resetOwnerAccessAlerts(ownerId);
    for (const item of resources) await notifyOwnerAccessProblem(ownerId, "token_expired", item);
    expect(sent).to.have.length(6);
  });

  for (const failure of ["rejected", "timeout"]) it(`retains the claim after ${failure} until owner action`, async () => {
    let attempts = 0;
    stub(global, "fetch", async () => { attempts++; if (failure === "timeout") throw new Error("timeout"); return { ok: false }; });
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    expect(attempts).to.equal(1);
    await notifications.resetOwnerAccessAlerts(ownerId, resource);
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    expect(attempts).to.equal(2);
  });

  it("does not claim an alert without configuration, an active owner, and an address", async () => {
    config.RESEND_API_KEY = "";
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    config.RESEND_API_KEY = "test-key";
    owner.status = "banned";
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    owner.status = "active"; owner.emails = [];
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    expect(claims).to.have.length(0);
    owner.notificationEmail = "alerts@example.com";
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    expect(sent[0].body.to).to.deep.equal(["alerts@example.com"]);
  });

  it("ignores transient failures and contains database failures", async () => {
    await notifyOwnerAccessProblem(ownerId, new Error("github_rate_limit_exceeded"), resource);
    await notifyOwnerAccessProblem(ownerId, Object.assign(new Error("repo_not_found"), { cause: { status: 503 } }), resource);
    expect(claims).to.have.length(0);
    stub(User, "findOne", () => { throw new Error("database down"); });
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    expect(sent).to.have.length(0);
  });

  it("recognizes raw authentication and missing-resource errors without alerting for outages", () => {
    for (const status of [401, 403, 404]) expect(notifications.isAccessFailure(Object.assign(new Error("GitHub rejected access"), { status }))).to.equal(true);
    for (const status of [429, 500, 503]) expect(notifications.isAccessFailure(Object.assign(new Error("upstream error"), { status }))).to.equal(false);
  });

  it("suppresses primary and secondary rate limits including wrapped streaming errors", () => {
    const AnonymousError = require("../src/core/AnonymousError").default;
    for (const error of [
      Object.assign(new Error("API rate limit exceeded"), { status: 403 }),
      Object.assign(new Error("abuse detection"), { status: 403 }),
      Object.assign(new Error("Forbidden"), { status: 403, response: { headers: { "x-ratelimit-remaining": "0" } } }),
      Object.assign(new Error("secondary rate limit"), { response: { statusCode: 403 } }),
    ]) {
      expect(notifications.isAccessFailure(error)).to.equal(false);
      expect(notifications.isAccessFailure(new AnonymousError("file_not_accessible", { httpStatus: 403, cause: error }))).to.equal(false);
    }
    const forbidden = Object.assign(new Error("SAML enforcement"), { response: { statusCode: 403 } });
    expect(notifications.isAccessFailure(new AnonymousError("file_not_accessible", { httpStatus: 403, cause: forbidden }))).to.equal(true);
  });

});

describe("owner email settings", () => {
  const utils = require("../src/server/routes/route-utils");
  const router = require("../src/server/routes/github-app").githubAppRouter;
  const endpoint = router.stack.find(layer => layer.route?.path === "/connections/email").route.stack[0].handle;
  const csrf = router.stack.find(layer => !layer.route && layer.handle.toString().includes("x-csrf-token")).handle;
  let oldUser, oldUpdate, writes;
  beforeEach(() => {
    writes = [];
    oldUser = utils.getUser; oldUpdate = User.updateOne;
    utils.getUser = async () => ({ id: "signed-in-owner" });
    User.updateOne = async (...args) => { writes.push(args); };
  });
  afterEach(() => { utils.getUser = oldUser; User.updateOne = oldUpdate; });
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } });
  it("updates only the signed-in owner's address", async () => {
    const res = response();
    await endpoint({ body: { email: " owner@example.com ", ownerId: "someone-else" } }, res);
    expect(writes).to.deep.equal([[{ _id: "signed-in-owner" }, { $set: { notificationEmail: "owner@example.com" } }]]);
    expect(res.body.notificationEmail).to.equal("owner@example.com");
  });
  it("rejects malformed input without a database write", async () => {
    const res = response();
    await endpoint({ body: { email: ["one@example.com", "two@example.com"] } }, res);
    expect(res.statusCode).to.equal(400);
    expect(writes).to.have.length(0);
  });
  for (const action of ["later", "never"]) it(`persists ${action} at the right scope`, async () => {
    const req = { body: { action }, session: { save: callback => callback() } };
    const res = response();
    await endpoint(req, res);
    expect(req.session.emailPromptDismissed).to.equal(true);
    expect(res.body.ok).to.equal(true);
    expect(writes).to.deep.equal(action === "never" ? [[{ _id: "signed-in-owner" }, { $set: { emailPromptNever: true } }]] : []);
  });
  it("rejects unknown preference actions", async () => {
    const res = response();
    await endpoint({ body: { action: "invalid" } }, res);
    expect(res.statusCode).to.equal(400);
    expect(writes).to.have.length(0);
  });
  it("initializes the same CSRF token for parallel session snapshots", () => {
    const { connectionCSRF } = require("../src/server/routes/github-app");
    const userRequest = { sessionID: "same-login-session", session: {} };
    const connectionsRequest = { sessionID: "same-login-session", session: {} };
    const popupToken = connectionCSRF(userRequest);
    const pageToken = connectionCSRF(connectionsRequest);
    expect(popupToken).to.equal(pageToken);
    expect(connectionCSRF({ sessionID: "another-login", session: {} })).not.to.equal(pageToken);
    for (const token of [popupToken, pageToken]) {
      let accepted = false;
      csrf({ method: "POST", session: connectionsRequest.session, headers: { "x-csrf-token": token } }, response(), () => { accepted = true; });
      expect(accepted).to.equal(true);
    }
  });
  it("requires the session's CSRF token before changing email", () => {
    const res = response(); let next = false;
    csrf({ method: "POST", session: { githubConnectionCSRF: "secret" }, headers: {} }, res, () => { next = true; });
    expect(res.statusCode).to.equal(403); expect(next).to.equal(false);
    csrf({ method: "POST", session: { githubConnectionCSRF: "secret" }, headers: { "x-csrf-token": "secret" } }, response(), () => { next = true; });
    expect(next).to.equal(true);
  });
});

describe("email popup eligibility", () => {
  const utils = require("../src/server/routes/route-utils");
  const router = require("../src/server/routes/user").default;
  const endpoint = router.stack.find(layer => layer.route?.path === "/" && layer.route.methods.get).route.stack[0].handle;
  let oldUser, oldKey, oldFrom;
  beforeEach(() => {
    oldUser = utils.getUser; oldKey = config.RESEND_API_KEY; oldFrom = config.EMAIL_FROM;
    config.RESEND_API_KEY = "test"; config.EMAIL_FROM = "alerts@example.com";
  });
  afterEach(() => { utils.getUser = oldUser; config.RESEND_API_KEY = oldKey; config.EMAIL_FROM = oldFrom; });
  for (const reason of ["eligible", "email", "alert-email", "never", "later", "no-key", "no-sender"]) {
    it(`checks ${reason} before showing the form`, async () => {
      utils.getUser = async () => ({ username: "owner", model: {
        emails: reason === "email" ? [{ email: "owner@example.com", default: true }] : [],
        notificationEmail: reason === "alert-email" ? "alerts@example.com" : undefined,
        emailPromptNever: reason === "never",
      } });
      if (reason === "no-key") config.RESEND_API_KEY = "";
      if (reason === "no-sender") config.EMAIL_FROM = "";
      const req = { session: { emailPromptDismissed: reason === "later", save: cb => cb() } };
      const res = { set() {}, json(body) { this.body = body; } };
      await endpoint(req, res);
      expect(res.body.showEmailPrompt).to.equal(reason === "eligible");
      expect(!!res.body.emailPromptCSRF).to.equal(reason === "eligible");
    });
  }
});

describe("repository notification hooks", () => {
  const Repository = require("../src/core/Repository").default;
  const RepositoryModel = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
  const Files = require("../src/core/model/files/files.model").default;
  const github = require("../src/core/source/GitHubRepository");
  const tokens = require("../src/core/GitHubUtils");
  const app = require("../src/core/github-app");
  const restores = [];
  const stub = (object, key, value) => { const old = object[key]; restores.push(() => object[key] = old); object[key] = value; };
  let repo, sent;
  beforeEach(() => {
    sent = [];
    repo = new Repository(new RepositoryModel({ repoId: "anonymous-id", owner: "507f1f77bcf86cd799439011", status: "ready",
      source: { repositoryName: "private/source", branch: "main" }, options: { expirationMode: "never", update: true } }));
    stub(notifications, "notifyOwnerAccessProblem", async (...args) => { sent.push(args); });
  });
  afterEach(() => { while (restores.length) restores.pop()(); });
  async function failsWith(work, error) {
    try { await work(); } catch (caught) { expect(caught).to.equal(error); return; }
    throw new Error("Expected original failure");
  }
  it("notifies the saved owner when an App repository token cannot be resolved", async () => {
    repo.model.githubAccess = { kind: "github-app", revision: "test" };
    const error = new Error("github_app_access_required");
    stub(app, "boundAppToken", async () => { throw error; });
    await failsWith(() => tokens.getToken(repo), error);
    expect(sent).to.deep.equal([[repo.owner.id, error, { kind: "repository", id: String(repo.model._id) }]]);
  });
  it("notifies the saved owner when reading the repository tree fails", async () => {
    const error = new Error("repo_not_found");
    stub(Files, "exists", () => ({ exec: async () => null }));
    Object.defineProperty(repo, "source", { value: { getFiles: async () => { throw error; } } });
    await failsWith(() => repo.files(), error);
    expect(sent).to.deep.equal([[repo.owner.id, error, { kind: "repository", id: String(repo.model._id) }]]);
  });
  for (const step of ["branches", "commit"]) it(`notifies on ${step} access errors during refresh`, async () => {
    const error = Object.assign(new Error("Forbidden"), { status: 403 });
    repo.getToken = async () => "token";
    stub(github, "getRepositoryFromGitHub", async () => ({
      fullName: repo.model.source.repositoryName, model: { defaultBranch: "main" },
      branches: async () => { if (step === "branches") throw error; return [{ name: "main", commit: "new-sha" }]; },
      getCommitInfo: async () => { throw error; },
    }));
    await failsWith(() => repo.updateIfNeeded({ force: true }), error);
    expect(sent).to.deep.equal([[repo.owner.id, error, { kind: "repository", id: String(repo.model._id) }]]);
  });
  it("notifies the saved owner when a repository refresh cannot read GitHub", async () => {
    const error = new Error("repo_not_found");
    repo.getToken = async () => "token";
    stub(github, "getRepositoryFromGitHub", async () => { throw error; });
    await failsWith(() => repo.updateIfNeeded({ force: true }), error);
    expect(sent).to.deep.equal([[repo.owner.id, error, { kind: "repository", id: String(repo.model._id) }]]);
  });
});

describe("gist and pull-request notification hooks", () => {
  const Gist = require("../src/core/Gist").default;
  const GistModel = require("../src/core/model/anonymizedGists/anonymizedGists.model").default;
  const PullRequest = require("../src/core/PullRequest").default;
  const PullRequestModel = require("../src/core/model/anonymizedPullRequests/anonymizedPullRequests.model").default;
  const github = require("../src/core/GitHubUtils");
  const restores = [];
  const stub = (object, key, value) => { const old = object[key]; restores.push(() => object[key] = old); object[key] = value; };
  let sent;
  beforeEach(() => { sent = []; stub(notifications, "notifyOwnerAccessProblem", async (...args) => { sent.push(args); }); });
  afterEach(() => { while (restores.length) restores.pop()(); });
  for (const type of ["gist", "pull-request"]) for (const failure of ["oauth", "app-access"]) {
    it(`alerts the owner on ${type} ${failure} failure and preserves the error`, async () => {
      const data = { owner: "507f1f77bcf86cd799439011", source: { gistId: "gist", repositoryFullName: "private/source", pullRequestId: 1 }, options: { expirationMode: "never" } };
      const resource = type === "gist" ? new Gist(new GistModel(data)) : new PullRequest(new PullRequestModel(data));
      const error = failure === "oauth" ? Object.assign(new Error("Bad credentials"), { status: 401 }) : new Error("github_app_access_required");
      if (type === "gist") {
        resource.getAccess = async () => {
          if (failure === "app-access") throw error;
          return { token: "token", connection: "oauth" };
        };
        resource.downloadContent = async () => { throw error; };
      } else {
        resource.getToken = async () => { if (failure === "app-access") throw error; return "token"; };
        stub(github, "octokit", () => ({ rest: { pulls: { get: async () => { throw error; } } } }));
      }
      let caught;
      try { await resource.download(); } catch (err) { caught = err; }
      expect(caught).to.be.instanceOf(Error);
      expect(caught.message).to.equal(type === "gist" && failure === "oauth" ? "github_oauth_required" : error.message);
      expect(sent).to.deep.equal([[resource.owner.id, caught, { kind: type, id: String(resource.model._id) }]]);
    });
  }
});

describe("streamed file access alerts", () => {
  const File = require("../src/core/AnonymizedFile").default;
  const AnonymousError = require("../src/core/AnonymousError").default;
  const { PassThrough } = require("stream");
  const got = require("got");
  const restores = [];
  const stub = (object, key, value) => { const old = object[key]; restores.push(() => object[key] = old); object[key] = value; };
  let sent, repository, file;
  beforeEach(() => {
    sent = [];
    stub(notifications, "notifyOwnerAccessProblem", async (owner, error) => { if (notifications.isAccessFailure(error)) sent.push({ owner, error }); });
    repository = { owner: { id: "saved-owner" }, options: { terms: [] }, model: { source: {} }, repoId: "anon-id", status: "ready", source: {},
      getToken: async () => "token", generateAnonymizeTransformer: () => new PassThrough() };
    file = new File({ repository, anonymizedPath: "README.md" });
  });
  afterEach(() => { while (restores.length) restores.pop()(); });
  for (const status of [403, 404, 503]) it(`handles local file download failure ${status}`, async () => {
    const cause = Object.assign(new Error("upstream"), { response: { statusCode: status } });
    const error = new AnonymousError(status === 403 ? "file_not_accessible" : status === 404 ? "file_not_found" : "upstream_error", { httpStatus: status, cause });
    repository.source.getFileContent = async () => { throw error; };
    let caught;
    try { await file.content(); } catch (err) { caught = err; }
    expect(caught).to.equal(error);
    expect(sent).to.have.length(status === 503 ? 0 : 1);
    if (sent.length) expect(sent[0].owner).to.equal("saved-owner");
  });
  for (const status of [403, 404, 503]) it(`handles remote streamer error ${status}`, async () => {
    stub(config, "STREAMER_ENTRYPOINT", "http://streamer/");
    const stream = new PassThrough();
    stub(got, "stream", () => stream);
    file.originalPath = async () => "README.md";
    file.sha = async () => "sha";
    file.size = async () => 10;
    const returned = await file.anonymizedContent();
    expect(returned).to.equal(stream);
    const error = Object.assign(new Error("streamer failure"), { response: { statusCode: status, body: JSON.stringify({ error: status === 503 ? "upstream_error" : "file_not_accessible" }) } });
    stream.emit("error", error);
    expect(sent).to.have.length(status === 503 ? 0 : 1);
    stream.destroy();
  });
});

describe("token validation preserves upstream failures", () => {
  const tokens = require("../src/core/GitHubUtils");
  const { registerGitHubToken } = require("../src/core/github-token-context");
  for (const status of [undefined, 403, 429, 500, 503]) it(`propagates token-check failure ${status}`, async () => {
    const error = Object.assign(new Error("upstream check failed"), { status });
    const token = `test-token-check-${status}`;
    registerGitHubToken(token, { quotaKey: token, publicRepository: "owner/repo", renew: async () => { throw error; } });
    let caught;
    try { await tokens.checkToken(token); } catch (err) { caught = err; }
    expect(caught).to.equal(error);
  });
  it("returns false only for a confirmed invalid token", async () => {
    const token = "test-token-check-invalid";
    registerGitHubToken(token, { quotaKey: token, publicRepository: "owner/repo", renew: async () => { throw Object.assign(new Error("Bad credentials"), { status: 401 }); } });
    expect(await tokens.checkToken(token)).to.equal(false);
  });
});

describe("repository probes and truncated file recovery", () => {
  const github = require("../src/core/GitHubUtils");
  const db = require("../src/server/database");
  const Model = require("../src/core/model/repositories/repositories.model").default;
  const Files = require("../src/core/model/files/files.model").default;
  const File = require("../src/core/AnonymizedFile").default;
  const GitHubStream = require("../src/core/source/GitHubStream").default;
  const { classifyGitHubMissError } = require("../src/core/source/GitHubBase");
  const restores = [];
  const stub = (object, key, value) => { const old = object[key]; restores.push(() => object[key] = old); object[key] = value; };
  const source = { getToken: async () => "probe-test", repoId: "anon", organization: "owner", repoName: "repo", commit: "sha" };
  const missing = () => Object.assign(new Error("Not found"), { status: 404 });
  afterEach(() => { while (restores.length) restores.pop()(); });
  for (const stage of ["name", "id"]) for (const status of [undefined, 429, 503]) {
    it(`propagates inconclusive ${stage} probe ${status}`, async () => {
      const error = Object.assign(new Error("probe failed"), { status });
      stub(db, "isConnected", true);
      stub(Model, "findOne", async () => ({ name: "owner/repo", externalId: "gh_123" }));
      stub(github, "octokit", () => ({ repos: { get: async () => { throw stage === "name" ? error : missing(); } }, request: async () => { throw error; } }));
      let caught;
      try { await classifyGitHubMissError(missing(), source); } catch (err) { caught = err; }
      expect(caught).to.equal(error);
      expect(notifications.isAccessFailure(caught)).to.equal(false);
    });
  }
  it("preserves an inconclusive repository probe during commit refresh", async () => {
    const { GitHubRepository } = require("../src/core/source/GitHubRepository");
    const error = Object.assign(new Error("probe unavailable"), { status: 503 });
    stub(github, "octokit", () => ({ repos: {
      getCommit: async () => { throw missing(); }, get: async () => { throw error; },
    } }));
    let caught;
    try { await new GitHubRepository({ name: "owner/repo" }).getCommitInfo("sha", { accessToken: "token" }); } catch (err) { caught = err; }
    expect(caught).to.equal(error);
    expect(notifications.isAccessFailure(caught)).to.equal(false);
  });
  for (const status of [403, 503]) it(`preserves truncated recovery error ${status} before file content is read`, async () => {
    const error = Object.assign(new Error("contents lookup failed"), { status });
    stub(github, "octokit", () => ({ repos: { getContent: async () => { throw error; } } }));
    stub(Files, "findOne", async () => null);
    const sent = [];
    stub(notifications, "notifyOwnerAccessProblem", async (owner, err) => { if (notifications.isAccessFailure(err)) sent.push(owner); });
    const file = new File({ anonymizedPath: "large/missing.txt", repository: {
      owner: { id: "saved-owner" }, repoId: "anon", options: { terms: [] },
      model: { truncatedFolders: ["large"] }, source: new GitHubStream(source),
    } });
    let caught;
    try { await file.originalPath(); } catch (err) { caught = err; }
    expect(caught).to.equal(error);
    expect(sent).to.deep.equal(status === 403 ? ["saved-owner"] : []);
  });
  for (const repoMissing of [false, true]) it(`distinguishes a missing truncated file from lost repository access: ${repoMissing}`, async () => {
    stub(db, "isConnected", false);
    stub(github, "octokit", () => ({ repos: {
      getContent: async () => { throw missing(); },
      get: async () => { if (repoMissing) throw missing(); return {}; },
    } }));
    let result, caught;
    try { result = await new GitHubStream(source).fetchFileInfoFromPath("large/missing.txt"); } catch (err) { caught = err; }
    if (repoMissing) expect(caught.message).to.equal("repo_not_found");
    else { expect(caught).to.equal(undefined); expect(result).to.equal(null); }
  });
});
