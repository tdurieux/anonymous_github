import * as express from "express";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import config from "../../config";
import UserModel from "../../core/model/users/users.model";
import CredentialModel from "../../core/model/credentials/credentials.model";
import InstallationModel from "../../core/model/github-installation";
import RepositoryModel from "../../core/model/anonymizedRepositories/anonymizedRepositories.model";
import PullRequestModel from "../../core/model/anonymizedPullRequests/anonymizedPullRequests.model";
import GistModel from "../../core/model/anonymizedGists/anonymizedGists.model";
import { getCredentialToken } from "../../core/credentials";
import { APP_PROVIDER, appError, appUserToken, AppInstallation, clearAppTokenCache, exchangeAppToken,
  githubRequest, GitHubRepositoryInfo, reconcileAppGrant, reconcileInstallation, installationURL, saveAppGrant, selectRepositoryAccess, userInstallations } from "../../core/github-app";
import { getUser, handleError } from "./route-utils";
import { isDisabledAccount, safeAuthReturnTo } from "./auth-utils";

type Flow = { state: string; expires: number; ownerId?: string; returnTo: string; repository?: string; install?: boolean };
declare module "express-session" {
  interface SessionData { githubAppFlow?: Flow; githubInstallFlow?: Flow; githubConnectionCSRF?: string; }
}
export function safeReturnTo(value: unknown): string {
  return safeAuthReturnTo(value, "/connections");
}
export function consumeFlow(flow: Flow | undefined, state: unknown): Flow {
  if (!flow || typeof state !== "string" || flow.state !== state || flow.expires < Date.now()) throw appError("invalid_auth_state", 400);
  return flow;
}
function newFlow(ownerId: string | undefined, returnTo: unknown): Flow {
  return { state: randomBytes(32).toString("hex"), expires: Date.now() + 10 * 60000, ownerId, returnTo: safeReturnTo(returnTo) };
}
function saveSession(req: express.Request) { return new Promise<void>((resolve, reject) => req.session.save(err => err ? reject(err) : resolve())); }
function enabled(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!config.GITHUB_APP_ENABLED || !config.GITHUB_APP_NEW_CONNECTIONS) return res.status(503).json({ error: "github_app_disabled" });
  next();
}
export const githubAppRouter = express.Router();
const router = githubAppRouter;
router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

router.get("/app/login", enabled, async (req, res) => {
  try {
    const ownerId = req.isAuthenticated() ? (await getUser(req)).id : undefined;
    const flow = newFlow(ownerId, req.query.returnTo || (ownerId ? "/connections" : "/dashboard"));
    flow.install = req.query.install === "1";
    if (typeof req.query.repository === "string" && /^[\w.-]+\/[\w.-]+$/.test(req.query.repository)) flow.repository = req.query.repository;
    req.session.githubAppFlow = flow;
    await saveSession(req);
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", config.GITHUB_APP_CLIENT_ID);
    url.searchParams.set("redirect_uri", config.GITHUB_APP_CALLBACK);
    url.searchParams.set("state", flow.state);
    res.redirect(url.toString());
  } catch (error) { handleError(error, res, req); }
});

router.get("/app/callback", enabled, async (req, res) => {
  try {
    const pending = req.session.githubAppFlow;
    delete req.session.githubAppFlow;
    await saveSession(req);
    const flow = consumeFlow(pending, req.query.state);
    if (typeof req.query.code !== "string" || req.query.error) throw appError("github_app_authorization_cancelled", 400);
    const tokens = await exchangeAppToken({ code: req.query.code, redirect_uri: config.GITHUB_APP_CALLBACK });
    const profile = await githubRequest<{ id: number; login: string; avatar_url?: string }>("/user", tokens.access_token);
    if (!Number.isSafeInteger(profile.id) || !profile.login) throw appError();
    let user = await UserModel.findOne({ "externalIDs.github": String(profile.id) });
    if (flow.ownerId) {
      const current = await getUser(req);
      if (current.id !== flow.ownerId || current.model.externalIDs?.github !== String(profile.id) || !user || user.id !== current.id) {
        throw appError("github_identity_mismatch", 409);
      }
    } else if (req.isAuthenticated()) {
      if (!user || user.id !== (await getUser(req)).id) throw appError("github_identity_mismatch", 409);
    }
    if (!user) {
      // A matching login name alone is not proof of account ownership.
      const existing = await UserModel.findOne({ username: profile.login });
      if (existing) {
        if (existing.externalIDs?.github || isDisabledAccount(existing.status)) throw appError("github_identity_mismatch", 409);
        req.session.githubRecovery = { ownerId: existing.id, githubId: String(profile.id), returnTo: flow.returnTo,
          expires: Date.now() + 10 * 60000, recovery: true };
        await saveSession(req);
        return res.redirect("/signin?recover=1");
      }
      user = new UserModel({ username: profile.login, externalIDs: { github: String(profile.id) }, photo: profile.avatar_url, emails: [] });
      await user.save();
    }
    if (isDisabledAccount(user.status)) throw appError("not_connected", 403);
    await saveAppGrant(user.id, tokens);
    await new Promise<void>((resolve, reject) => req.login({ username: user!.username, user }, err => err ? reject(err) : resolve()));
    res.redirect(flow.install ? `/github/app/install?returnTo=${encodeURIComponent(flow.returnTo)}&repository=${encodeURIComponent(flow.repository || "")}` : flow.returnTo);
  } catch (error) { handleError(error, res, req); }
});

router.get("/app/install", enabled, async (req, res) => {
  try {
    const user = await getUser(req);
    await appUserToken(user.id); // Authorization and installation are separate.
    const flow = newFlow(user.id, req.query.returnTo);
    req.session.githubInstallFlow = flow;
    let target = installationURL();
    const installations = await userInstallations(user.id);
    if (typeof req.query.installationId === "string") {
      const installation = installations.find(i => String(i.id) === req.query.installationId);
      if (!installation) throw appError("github_app_access_required");
      target = installation.account.type === "Organization"
        ? `https://github.com/organizations/${encodeURIComponent(installation.account.login)}/settings/installations/${installation.id}`
        : `https://github.com/settings/installations/${installation.id}`;
    } else if (typeof req.query.repository === "string" && /^[\w.-]+\/[\w.-]+$/.test(req.query.repository)) {
      // Existing OAuth grants can preselect a private repo during initial migration.
      const token = await getCredentialToken(user.id) || await appUserToken(user.id);
      try {
        const repo = await githubRequest<GitHubRepositoryInfo>(`/repos/${req.query.repository}`, token);
        const existing = installations.find(i => i.account.id === repo.owner.id);
        target = existing ? (existing.account.type === "Organization"
          ? `https://github.com/organizations/${encodeURIComponent(existing.account.login)}/settings/installations/${existing.id}`
          : `https://github.com/settings/installations/${existing.id}`) : installationURL(repo.owner.id, [repo.id]);
      } catch { /* A new private repository may be invisible until installation. */ }
    }
    const url = new URL(target);
    url.searchParams.set("state", flow.state);
    await saveSession(req);
    res.redirect(url.toString());
  } catch (error) { handleError(error, res, req); }
});

router.get("/app/setup", enabled, async (req, res) => {
  try {
    const pending = req.session.githubInstallFlow;
    delete req.session.githubInstallFlow;
    await saveSession(req);
    if (!req.isAuthenticated()) return res.redirect("/github/app/login");
    const user = await getUser(req);
    // GitHub-initiated installs or configuration pages may not return state.
    // Without returned state, never attach anything based on installation_id.
    // A recent flow owned by this session is safe to use only for local navigation.
    if (!req.query.state) return res.redirect(pending?.ownerId === user.id && pending.expires > Date.now()
      ? safeReturnTo(pending.returnTo) : "/connections");
    const flow = consumeFlow(pending, req.query.state);
    if (flow.ownerId !== user.id) throw appError("invalid_auth_state", 400);
    if (req.query.setup_action !== "request") {
      const installations = await userInstallations(user.id);
      if (!installations.some(i => String(i.id) === req.query.installation_id)) throw appError("github_app_access_required");
    }
    await UserModel.updateOne({ _id: user.id }, { $set: { repositories: [] } });
    res.redirect(flow.returnTo);
  } catch (error) { handleError(error, res, req); }
});

router.get("/connections", async (req, res) => {
  try {
    const user = await getUser(req);
    req.session.githubConnectionCSRF ||= randomBytes(32).toString("hex");
    await saveSession(req);
    const credentials = await CredentialModel.find({ ownerId: user.id }).select("provider revoked").lean();
    const appConnected = credentials.some(c => c.provider === APP_PROVIDER && !c.revoked);
    let installations: { id: number; account: string; suspended: boolean }[] = [];
    let appErrorCode: string | undefined;
    if (appConnected && config.GITHUB_APP_ENABLED) {
      try {
        const verified = await userInstallations(user.id);
        installations = verified.map(i => ({ id: i.id, account: i.account.login, suspended: !!i.suspended_at }));

      }
      catch (error) { appErrorCode = error instanceof Error ? error.message : "github_app_reconnect_required"; }
    }
    const repos = await RepositoryModel.find({ owner: user.id, status: { $ne: "removed" } }).select("repoId source.repositoryName githubAccess status").lean();
    const prs = await PullRequestModel.find({ owner: user.id, status: { $ne: "removed" } }).select("pullRequestId source.repositoryFullName githubAccess status").lean();
    const gistCount = await GistModel.countDocuments({ owner: user.id, status: { $ne: "removed" } });
    res.json({ csrf: req.session.githubConnectionCSRF, appEnabled: config.GITHUB_APP_ENABLED && config.GITHUB_APP_NEW_CONNECTIONS,
      oauthEnabled: config.GITHUB_OAUTH_ENABLED, oauthConnected: !!(await getCredentialToken(user.id)), appConnected, appError: appErrorCode,
      installations, gistCount, resources: [
        ...repos.map(r => ({ type: "repository", id: r.repoId, name: r.source.repositoryName, connection: r.githubAccess?.kind || "oauth", status: r.status })),
        ...prs.map(r => ({ type: "pull-request", id: r.pullRequestId, name: r.source.repositoryFullName, connection: r.githubAccess?.kind || "oauth", status: r.status })),
      ] });
  } catch (error) { handleError(error, res, req); }
});

router.use("/connections", (req, res, next) => {
  if (req.method !== "GET" && (!req.session.githubConnectionCSRF || req.headers["x-csrf-token"] !== req.session.githubConnectionCSRF)) {
    return res.status(403).json({ error: "invalid_auth_state" });
  }
  next();
});

router.post("/connections/migrate", async (req, res) => {
  try {
    const user = await getUser(req);
    const { type, id, connection, preview } = req.body;
    if (typeof id !== "string" || !["repository", "pull-request"].includes(type) || !["oauth", "github-app"].includes(connection)) throw appError("invalid_connection", 400);
    if (connection === "github-app" && (!config.GITHUB_APP_ENABLED || !config.GITHUB_APP_NEW_CONNECTIONS)) throw appError("github_app_disabled", 503);
    const isRepo = type === "repository";
    const model = isRepo ? await RepositoryModel.findOne({ repoId: id, owner: user.id }) : await PullRequestModel.findOne({ pullRequestId: id, owner: user.id });
    if (!model || ["removed", "archived"].includes(model.status || "")) throw appError("repo_not_found", 404);
    if (["preparing", "removing", "expiring"].includes(model.status || "")) throw appError("repository_busy", 409);
    const source = model.source as { repositoryName?: string; repositoryFullName?: string; commit?: string; pullRequestId?: number };
    const name = source.repositoryName || source.repositoryFullName || "";
    const selected = await selectRepositoryAccess(user.id, name, connection);
    const parts = name.split("/").map(encodeURIComponent).join("/");
    await githubRequest(`/repos/${parts}/${isRepo ? `commits/${encodeURIComponent(source.commit || "")}` : `pulls/${source.pullRequestId}`}`, selected.token);
    if (preview === true) return res.json({ eligible: true, connection });
    const filter = { _id: model._id, owner: user.id, status: model.status, source: model.source,
      githubAccess: model.githubAccess ? model.githubAccess : { $exists: false } };
    const change = { $set: { githubAccess: selected.binding } };
    const result = isRepo ? await RepositoryModel.updateOne(filter, change) : await PullRequestModel.updateOne(filter, change);
    if (!result.modifiedCount) throw appError("connection_changed", 409);
    res.json({ connection });
  } catch (error) { handleError(error, res, req); }
});

export async function revokeGrant(ownerId: string, provider: "github" | "github-app-user") {
  const token = await getCredentialToken(ownerId, provider);
  const clientId = provider === "github" ? config.CLIENT_ID : config.GITHUB_APP_CLIENT_ID;
  const clientSecret = provider === "github" ? config.CLIENT_SECRET : config.GITHUB_APP_CLIENT_SECRET;
  if (token) {
    const response = await fetch(`https://api.github.com/applications/${clientId}/grant`, { method: "DELETE",
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/json", Accept: "application/vnd.github+json" },
      body: JSON.stringify({ access_token: token }), signal: AbortSignal.timeout(20000) });
    if (!response.ok && response.status !== 404 && response.status !== 422) throw appError("github_grant_revocation_failed", 502);
  }
  await CredentialModel.deleteMany({ ownerId, provider });
  if (provider === "github") await UserModel.updateOne({ _id: ownerId }, { $unset: { "accessTokens.github": "", "accessTokenDates.github": "" } });
  await UserModel.updateOne({ _id: ownerId }, { $set: { repositories: [] } });
}
router.post("/connections/disconnect-oauth", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!(await CredentialModel.exists({ ownerId: user.id, provider: APP_PROVIDER, revoked: { $ne: true } }))) throw appError("another_login_required", 409);
    await appUserToken(user.id);
    const active = { owner: user.id, status: { $ne: "removed" }, "githubAccess.kind": { $ne: "github-app" } };
    if (await RepositoryModel.exists(active) || await PullRequestModel.exists(active) || await GistModel.exists({ owner: user.id, status: { $ne: "removed" } })) {
      throw appError("oauth_resources_remaining", 409);
    }
    await revokeGrant(user.id, "github");
    res.json({ disconnected: true });
  } catch (error) { handleError(error, res, req); }
});

export function validWebhookSignature(body: Buffer, signature: unknown, secret: string): boolean {
  if (!secret || typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
export const githubAppWebhook = express.Router();
githubAppWebhook.post("/", express.raw({ type: "application/json", limit: "2mb" }), async (req, res) => {
  if (!config.GITHUB_APP_ENABLED || !Buffer.isBuffer(req.body) || !validWebhookSignature(req.body, req.headers["x-hub-signature-256"], config.GITHUB_APP_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: "invalid_webhook_signature" });
  }
  try {
    const body = JSON.parse(req.body.toString("utf8"));
    const event = req.headers["x-github-event"];
    if (event === "github_app_authorization" && body.action === "revoked" && body.sender?.id) {
      const users = await UserModel.find({ "externalIDs.github": String(body.sender.id) }).select("_id").lean();
      for (const user of users) await reconcileAppGrant(String(user._id));
    }
    if (["installation", "installation_repositories"].includes(String(event)) && Number.isSafeInteger(body.installation?.id) && String(body.installation.app_id) === config.GITHUB_APP_ID) {
      const installation = body.installation as AppInstallation;
      // Fail closed immediately. Reconcile from GitHub, never trust event order
      // to reactivate an installation. Duplicate events are safe to replay.
      const filter = { appId: config.GITHUB_APP_ID, installationId: installation.id };
      const revision = randomUUID();
      await InstallationModel.updateOne(filter, { $set: { blocked: true, revision,
        reconciliationPending: body.action !== "deleted" } }, { upsert: true });
      clearAppTokenCache();
      if (body.action !== "deleted") await reconcileInstallation(installation.id, revision);
    }
    return res.status(204).end();
  } catch { return res.status(503).json({ error: "webhook_processing_failed" }); }
});
