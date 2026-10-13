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
  let owner, ownerState, sent, claims, rows, generations, resourceRevisions, attemptIds, recipients, events;
  beforeEach(() => {
    owner = { status: "active", emails: [{ email: "owner@example.com", default: true }] };
    ownerState = {};
    sent = []; claims = []; rows = new Map(); generations = new Map(); recipients = new Map(); events = [];
    resourceRevisions = new Map(); attemptIds = new Map();
    stub(config, "RESEND_API_KEY", "test-resend-key");
    stub(config, "EMAIL_FROM", "alerts@example.com");
    stub(config, "APP_HOSTNAME", "anonymous.example.com");
    stub(User, "findOne", () => ({ lean: async () => ["removed", "banned"].includes(owner?.status) ? null : owner }));
    stub(User, "findById", () => ({ select: () => ({ lean: async () => owner }) }));
    Object.defineProperty(User.db, "readyState", { configurable: true, value: 1 });
    restores.push(() => { delete User.db.readyState; });
    stub(User.db, "collection", name => {
      if (name === "users") return {
        findOne: async filter => String(filter._id) === ownerId ? { ...ownerState } : null,
        findOneAndUpdate: async (filter, update) => {
          if (String(filter._id) !== ownerId) return { value: null };
          ownerState.accessAlertResetRevision = (ownerState.accessAlertResetRevision || 0) + update.$inc.accessAlertResetRevision;
          Object.assign(ownerState, update.$set); return { value: { ...ownerState } };
        },
        updateOne: async (filter, update) => {
          if (String(filter._id) !== ownerId) return { matchedCount: 0 };
          if ("accessAlertResetRevision" in filter && ownerState.accessAlertResetRevision !== (typeof filter.accessAlertResetRevision === "number" ? filter.accessAlertResetRevision : undefined)) return { matchedCount: 0 };
          if (filter.$or && ownerState.accessAlertResetUntil?.getTime() > Date.now()) return { matchedCount: 0 };
          const get = path => path.split(".").reduce((value, key) => value?.[key], ownerState);
          const set = (path, value) => {
            const keys = path.split("."), last = keys.pop(); let target = ownerState;
            for (const key of keys) target = target[key] ||= {};
            if (value === undefined) delete target[last]; else target[last] = value;
          };
          for (const [key, value] of Object.entries(filter)) if (key.startsWith("accessAlertDispatches.") && get(key) !== value) return { matchedCount: 0 };
          if (Array.isArray(update)) {
            const cutoff = update[0].$set.accessAlertDispatches.$arrayToObject.$filter.cond.$or[1].$gt[1];
            ownerState.accessAlertDispatches = Object.fromEntries(Object.entries(ownerState.accessAlertDispatches || {}).filter(([, value]) => value.state === "committed" || value.claimedAt > cutoff));
            for (const [key, value] of Object.entries(update[1].$set)) set(key, value);
          } else {
            if (update.$inc) for (const [key, value] of Object.entries(update.$inc)) set(key, (get(key) || 0) + value);
            if (update.$set) for (const [key, value] of Object.entries(update.$set)) set(key, value);
            if (update.$unset) for (const key of Object.keys(update.$unset)) set(key, undefined);
          }
          return { matchedCount: 1 };
        },
      };
      if (name === "owner_access_alert_events") return { insertOne: async record => events.push(record), findOne: async filter => events.find(event => event._id === filter._id) };
      if (name === notifications.RECIPIENT_ALERTS) return {
        findOne: async filter => recipients.get(filter._id),
        find: filter => {
          const matching = () => [...recipients.values()].filter(r => {
            if (filter.deferredRecoveries) return r.deferredRecoveries?.some(recovery => String(recovery.owner) === String(filter.deferredRecoveries.$elemMatch.owner));
            const claim = filter.$or[0];
            return String(r.owner) === String(claim.owner) && r.resourceKind === claim.resourceKind
              && String(r.resourceId) === String(claim.resourceId) && r.generation !== claim.generation.$ne && filter.state.$in.includes(r.state);
          }).map(r => ({ ...r }));
          return { toArray: async () => matching(), async *[Symbol.asyncIterator]() { yield* matching(); } };
        },
        updateMany: async filter => { if (filter.legacyClaims?.$elemMatch) return; const claim = filter; for (const r of recipients.values()) if (String(r.owner) === String(claim.owner)
          && (!claim.resourceId || String(r.resourceId) === String(claim.resourceId))) r.resetRevision = (r.resetRevision || 0) + 1; },
        insertOne: async record => { if (recipients.has(record._id)) throw Object.assign(new Error("duplicate"), { code: 11000 }); recipients.set(record._id, { ...record }); },
        updateOne: async (filter, update) => { const record = recipients.get(filter._id);
          const stateMatches = !filter.state || (typeof filter.state === "string" ? record?.state === filter.state : filter.state.$in.includes(record?.state));
          const revisionMatches = !("resetRevision" in filter) || record?.resetRevision === (typeof filter.resetRevision === "number" ? filter.resetRevision : undefined);
          if (!record || record.attemptId !== filter.attemptId || !stateMatches || !revisionMatches) return { matchedCount: 0 };
          if (Array.isArray(update)) {
            const recovery = update[0].$set.deferredRecoveries.$concatArrays[1][0];
            record.deferredRecoveries = [recovery];
          } else Object.assign(record, update.$set);
          return { matchedCount: 1 };
        },
        deleteOne: async filter => { const r = recipients.get(filter._id);
          const stateMatches = typeof filter.state === "string" ? r?.state === filter.state : filter.state.$in.includes(r?.state);
          const revisionMatches = !("resetRevision" in filter) || r?.resetRevision === (typeof filter.resetRevision === "number" ? filter.resetRevision : undefined);
          if (r?.attemptId === filter.attemptId && stateMatches && revisionMatches) { recipients.delete(filter._id); return { deletedCount: 1 }; }
          return { deletedCount: 0 };
        },
        deleteMany: async filter => { let deletedCount = 0; for (const [key, r] of recipients) {
          if (String(r.owner) === String(filter.owner) && r.resourceKind === filter.resourceKind && String(r.resourceId) === String(filter.resourceId)
            && r.generation !== filter.generation.$ne && filter.state.$in.includes(r.state)) { recipients.delete(key); deletedCount++; }
        } return { deletedCount }; },
      };
      return {
        findOne: async filter => {
          const key = `${name}:${filter.owner}:${filter._id}`;
          if (!generations.has(key)) generations.set(key, undefined);
          if ("accessAlertGeneration" in filter && generations.get(key) !== (typeof filter.accessAlertGeneration === "string" ? filter.accessAlertGeneration : undefined)) return null;
          if (filter.accessAlertClaimedAt?.$exists && !rows.has(key)) return null;
          if ("accessAlertClaimRevision" in filter && (resourceRevisions.get(key) || 0) !== (typeof filter.accessAlertClaimRevision === "number" ? filter.accessAlertClaimRevision : 0)) return null;
          if (filter.accessAlertAttemptId && attemptIds.get(key) !== filter.accessAlertAttemptId) return null;
          return { accessAlertGeneration: generations.get(key), accessAlertClaimedAt: rows.get(key), accessAlertClaimRevision: resourceRevisions.get(key), status: "ready" };
        },
        updateOne: async (filter, update) => {
          claims.push(filter); const key = `${name}:${filter.owner}:${filter._id}`;
          if (generations.get(key) !== (typeof filter.accessAlertGeneration === "string" ? filter.accessAlertGeneration : undefined)) return { matchedCount: 0 };
          const revision = resourceRevisions.get(key) || 0;
          if (Array.isArray(update)) {
            const first = filter.$or[0].accessAlertClaimRevision;
            const expected = typeof first === "number" ? first : 0;
            const attemptId = update[0].$set.accessAlertAttemptId.$cond[0].$eq[1];
            if (revision !== expected && !(revision === expected + 1 && attemptIds.get(key) === attemptId)) return { matchedCount: 0 };
            resourceRevisions.set(key, revision + 1);
            if (attemptIds.get(key) === attemptId) { rows.delete(key); attemptIds.delete(key); }
          } else {
            if ("accessAlertClaimRevision" in filter && revision !== (typeof filter.accessAlertClaimRevision === "number" ? filter.accessAlertClaimRevision : 0)) return { matchedCount: 0 };
            rows.set(key, update.$set.accessAlertClaimedAt); attemptIds.set(key, update.$set.accessAlertAttemptId);
            resourceRevisions.set(key, revision + update.$inc.accessAlertClaimRevision);
          }
          return { matchedCount: 1 };
        },
        updateMany: async (filter, update) => {
          for (const key of generations.keys()) if (key.startsWith(`${name}:${filter.owner}:`) && (!filter._id || key.endsWith(`:${filter._id}`))) {
            rows.delete(key); attemptIds.delete(key); generations.set(key, update.$set.accessAlertGeneration);
          }
        },
      };
    });
    stub(global, "fetch", async (url, options) => { sent.push({ url, options, body: JSON.parse(options.body) }); return { ok: true, status: 200 }; });
  });
  afterEach(() => { while (restores.length) restores.pop()(); });

  it("accepts one mailbox and rejects recipient lists and header injection", () => {
    expect(normalizeEmail(" Owner+alerts@example.com ")).to.equal("Owner+alerts@example.com");
    for (const value of [undefined, {}, "a@b.com,b@b.com", "Person <a@b.com>", "a@b.com\r\nBcc: x@y.com", ".a@b.com", "a..b@b.com", "a".repeat(65) + "@example.com"]) {
      expect(normalizeEmail(value)).to.equal(null);
    }
    expect(notificationEmail([{ email: "first@example.com", default: false }, { email: "primary@example.com", default: true }])).to.equal("primary@example.com");
  });

  it("sends once per recipient across resources and concurrent readers, with no time expiry", async () => {
    await Promise.all(Array.from({ length: 10 }, () => notifyOwnerAccessProblem(ownerId, "token_expired", resource)));
    expect(sent).to.have.length(1);
    for (const key of rows.keys()) rows.set(key, new Date("2000-01-01"));
    await notifyOwnerAccessProblem(ownerId, "repo_not_found", resource);
    expect(sent).to.have.length(1);
    await notifyOwnerAccessProblem(ownerId, "repo_not_found", other);
    expect(sent).to.have.length(1);
    expect(sent[0].url).to.equal("https://api.resend.com/emails");
    expect(sent[0].body.to).to.deep.equal(["owner@example.com"]);
    expect(sent[0].body.text).to.include("https://anonymous.example.com/connections");
    expect(sent[0].options.headers["Idempotency-Key"]).to.match(/^owner-access-alert\//);
    expect(events[0].state).to.equal("prepared");
    expect(events[1].state).to.equal("accepted");
  });

  it("reopens an alert only after owner action and successful access to its triggering resource", async () => {
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    await notifyOwnerAccessProblem(ownerId, "token_expired", other);
    expect(sent).to.have.length(1);
    await notifications.resetOwnerAccessAlerts(ownerId, resource);
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    expect(sent).to.have.length(1);
    await notifications.withOwnerAccessRecovery(ownerId, other, async () => {});
    expect(recipients.size).to.equal(1);
    await notifications.withOwnerAccessRecovery(ownerId, resource, async () => {});
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    expect(sent).to.have.length(2);
    expect(events).to.have.length(4);
  });

  it("cannot clear another owner's recipient guard", async () => {
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    await notifications.resetOwnerAccessAlerts("507f1f77bcf86cd799439099", resource);
    await notifications.withOwnerAccessRecovery("507f1f77bcf86cd799439099", resource, async () => {});
    expect(recipients.size).to.equal(1);
  });

  it("does not reopen on background success without owner action", async () => {
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    await notifications.withOwnerAccessRecovery(ownerId, resource, async () => {});
    expect(recipients.size).to.equal(1);
  });

  it("retains the guard when access recovery fails", async () => {
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    await notifications.resetOwnerAccessAlerts(ownerId, resource);
    try { await notifications.withOwnerAccessRecovery(ownerId, resource, async () => { throw new Error("still forbidden"); }); } catch { /* Expected upstream failure. */ }
    expect(recipients.size).to.equal(1);
  });

  it("rejects a pre-action failure paused during owner lookup", async () => {
    let resume, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    stub(User, "findOne", () => ({ lean: async () => {
      entered();
      await new Promise(resolve => { resume = resolve; });
      return owner;
    } }));
    const oldFailure = notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    await waiting;
    await notifications.resetOwnerAccessAlerts(ownerId, resource);
    resume();
    await oldFailure;
    expect(sent).to.have.length(0);
    stub(User, "findOne", () => ({ lean: async () => owner }));
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    expect(sent).to.have.length(1);
  });

  it("reconnecting leaves the recipient blocked across all resource types", async () => {
    const resources = [resource, { ...resource, kind: "pull-request" }, { ...resource, kind: "gist" }];
    for (const item of resources) await notifyOwnerAccessProblem(ownerId, "token_expired", item);
    expect(sent).to.have.length(1);
    await notifications.resetOwnerAccessAlerts(ownerId);
    for (const item of resources) await notifyOwnerAccessProblem(ownerId, "token_expired", item);
    expect(sent).to.have.length(1);
  });

  for (const failure of ["rejected", "timeout"]) it(`retains the claim after ${failure} until confirmed recovery`, async () => {
    let attempts = 0;
    stub(global, "fetch", async () => { attempts++; if (failure === "timeout") throw new Error("timeout"); return { ok: false }; });
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    expect(attempts).to.equal(1);
    await notifications.resetOwnerAccessAlerts(ownerId, resource);
    await notifyOwnerAccessProblem(ownerId, "token_expired", resource);
    expect(attempts).to.equal(1);
    await notifications.withOwnerAccessRecovery(ownerId, resource, async () => {});
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
  const endpoint = router.stack.find(layer => layer.route?.path === "/connections/email" && layer.route.methods.post).route.stack[0].handle;
  const readEmail = router.stack.find(layer => layer.route?.path === "/connections/email" && layer.route.methods.get).route.stack[0].handle;
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
  for (const email of ["", "primary@example.com"]) it(`loads the account email and persists its save token (${email || "no address"})`, async () => {
    utils.getUser = async () => ({ id: "signed-in-owner", model: { emails: [], notificationEmail: email } });
    let saved = false;
    const req = { sessionID: "profile-session", session: { save: done => { saved = true; done(); } } };
    const res = response();
    await readEmail(req, res);
    expect(saved).to.equal(true);
    expect(res.body).to.deep.equal({ notificationEmail: email, csrf: req.session.githubConnectionCSRF });
    expect(res.body.csrf).to.be.a("string").with.length(64);
    expect(writes).to.have.length(0);
  });
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
