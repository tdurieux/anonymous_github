const { expect } = require("chai");
require("ts-node/register/transpile-only");
const config = require("../src/config").default;
const User = require("../src/core/model/users/users.model").default;
const notifications = require("../src/core/owner-notifications");
const { normalizeEmail, notificationEmail, notifyOwnerAccessProblem } = notifications;

describe("owner access notifications", () => {
  const restores = [];
  const stub = (object, key, value) => { const old = object[key]; restores.push(() => object[key] = old); object[key] = value; };
  let sent, claims, retryWrites, owner, after;
  beforeEach(() => {
    sent = []; claims = []; retryWrites = []; after = null;
    owner = { status: "active", emails: [{ email: "owner@example.com", default: true }] };
    stub(config, "RESEND_API_KEY", "test-resend-key");
    stub(config, "EMAIL_FROM", "alerts@example.com");
    stub(config, "APP_HOSTNAME", "anonymous.example.com");
    stub(User, "findOneAndUpdate", (filter, update) => ({ lean: async () => {
      claims.push(filter);
      if (!owner || ["removed", "banned"].includes(owner.status) || (!owner.emails.length && !owner.notificationEmail) || after > new Date()) return null;
      after = update.$set.accessAlertAfter;
      return owner;
    } }));
    stub(User, "updateOne", async (filter, update) => { retryWrites.push({ filter, update }); after = update.$set.accessAlertAfter; });
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

  it("sends one private Resend message across concurrent failures", async () => {
    await Promise.all(Array.from({ length: 10 }, () => notifyOwnerAccessProblem("owner-id", "token_expired")));
    expect(sent).to.have.length(1);
    expect(sent[0].url).to.equal("https://api.resend.com/emails");
    expect(sent[0].options.headers.Authorization).to.equal("Bearer test-resend-key");
    expect(sent[0].body.to).to.deep.equal(["owner@example.com"]);
    expect(sent[0].body.text).to.include("https://anonymous.example.com/connections");
    expect(JSON.stringify(sent[0].body)).not.to.include("test-resend-key");
    expect(claims[0].status).to.deep.equal({ $nin: ["removed", "banned"] });
    expect(claims[0].$or).to.have.length(2);
  });

  it("ignores disabled delivery, missing recipients and transient failures", async () => {
    for (const code of ["github_rate_limit_exceeded", "github_unavailable", "ETIMEDOUT", "quota_exceeded"]) {
      await notifyOwnerAccessProblem("owner-id", new Error(code));
    }
    await notifyOwnerAccessProblem("owner-id", Object.assign(new Error("repo_not_found"), { cause: { status: 503 } }));
    await notifyOwnerAccessProblem("owner-id", Object.assign(new Error("token_expired"), { cause: new Error("network timeout") }));
    expect(claims).to.have.length(0);
    owner.emails = [];
    await notifyOwnerAccessProblem("owner-id", "repo_not_found");
    owner.emails = [{ email: "owner@example.com", default: true }];
    owner.status = "banned";
    await notifyOwnerAccessProblem("owner-id", "repo_not_found");
    config.RESEND_API_KEY = "";
    await notifyOwnerAccessProblem("owner-id", "token_expired");
    expect(sent).to.have.length(0);
  });

  it("backs off after delivery failure without throwing", async () => {
    stub(global, "fetch", async () => ({ ok: false }));
    await notifyOwnerAccessProblem("owner-id", "repo_not_accessible");
    expect(retryWrites).to.have.length(1);
    expect(after.getTime() - Date.now()).to.be.within(590000, 600000);
    await notifyOwnerAccessProblem("owner-id", "repo_not_accessible");
    expect(retryWrites).to.have.length(1);
  });

  it("retains the daily claim when delivery may already have happened", async () => {
    let attempts = 0;
    stub(global, "fetch", async () => { attempts++; throw new Error("response timed out after acceptance"); });
    await notifyOwnerAccessProblem("owner-id", "token_expired");
    expect(retryWrites).to.have.length(0);
    expect(after.getTime() - Date.now()).to.be.within(86390000, 86400000);
    await notifyOwnerAccessProblem("owner-id", "token_expired");
    expect(attempts).to.equal(1);
  });

  it("uses a dedicated alert address without requiring or replacing profile emails", async () => {
    owner.notificationEmail = "alerts@example.com";
    const original = JSON.stringify(owner.emails);
    await notifyOwnerAccessProblem("owner-id", "token_expired");
    expect(sent[0].body.to).to.deep.equal(["alerts@example.com"]);
    expect(JSON.stringify(owner.emails)).to.equal(original);
    after = null; owner.emails = [];
    await notifyOwnerAccessProblem("owner-id", "token_expired");
    expect(sent).to.have.length(2);
  });

  it("recognizes raw authentication and missing-resource errors without alerting for outages", () => {
    for (const status of [401, 404]) expect(notifications.isAccessFailure(Object.assign(new Error("GitHub rejected access"), { status }))).to.equal(true);
    for (const status of [429, 500, 503]) expect(notifications.isAccessFailure(Object.assign(new Error("upstream error"), { status }))).to.equal(false);
  });

  it("does not let database failures escape", async () => {
    stub(User, "findOneAndUpdate", () => { throw new Error("database down"); });
    await notifyOwnerAccessProblem("owner-id", "token_expired");
    expect(sent).to.have.length(0);
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
    expect(sent).to.deep.equal([[repo.owner.id, error]]);
  });
  it("notifies the saved owner when reading the repository tree fails", async () => {
    const error = new Error("repo_not_found");
    stub(Files, "exists", () => ({ exec: async () => null }));
    Object.defineProperty(repo, "source", { value: { getFiles: async () => { throw error; } } });
    await failsWith(() => repo.files(), error);
    expect(sent).to.deep.equal([[repo.owner.id, error]]);
  });
  it("notifies the saved owner when a repository refresh cannot read GitHub", async () => {
    const error = new Error("repo_not_found");
    repo.getToken = async () => "token";
    stub(github, "getRepositoryFromGitHub", async () => { throw error; });
    await failsWith(() => repo.updateIfNeeded({ force: true }), error);
    expect(sent).to.deep.equal([[repo.owner.id, error]]);
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
      expect(sent).to.deep.equal([[resource.owner.id, caught]]);
    });
  }
});
