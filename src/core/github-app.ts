import { registerGitHubToken } from "./github-token-context";
import { createSign, randomUUID } from "crypto";
import { readFileSync } from "fs";
import config from "../config";
import AnonymousError from "./AnonymousError";
import CredentialModel from "./model/credentials/credentials.model";
import InstallationModel from "./model/github-installation";
import UserModel from "./model/users/users.model";
import { credentialCipher, getCredentialToken } from "./credentials";
import { RepositoryAccess } from "./repository-access.types";

export const APP_PROVIDER = "github-app-user";
export function appError(code = "github_app_reconnect_required", status = 403) {
  return new AnonymousError(code, { httpStatus: status });
}

// Never expose upstream bodies, bearer credentials or signed URLs in errors.
export async function githubRequest<T>(path: string, token: string, method = "GET", body?: unknown): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) throw appError("invalid_github_path", 400);
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      method, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
  } catch { throw appError("github_unavailable", 502); }
  if (!response.ok) {
    const limited = response.status === 429 || (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
    throw appError(limited ? "github_rate_limit_exceeded" : response.status >= 500 ? "github_unavailable" :
      response.status === 401 ? "github_app_reconnect_required" : "github_app_access_required",
    limited ? 429 : response.status >= 500 ? 502 : 403);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export function appJWT(now = Date.now()): string {
  if (!config.GITHUB_APP_ENABLED) throw appError("github_app_disabled", 503);
  const key = config.GITHUB_APP_PRIVATE_KEY || readFileSync(config.GITHUB_APP_PRIVATE_KEY_FILE, "utf8");
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: Math.floor(now / 1000) - 60,
    exp: Math.floor(now / 1000) + 540, iss: config.GITHUB_APP_CLIENT_ID })}`;
  return `${payload}.${createSign("RSA-SHA256").update(payload).sign(key, "base64url")}`;
}

export interface AppTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in: number;
}
export async function exchangeAppToken(values: Record<string, string>): Promise<AppTokenResponse> {
  let response: Response;
  try {
    response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, client_id: config.GITHUB_APP_CLIENT_ID, client_secret: config.GITHUB_APP_CLIENT_SECRET }),
      signal: AbortSignal.timeout(20000),
    });
  } catch { throw appError("github_unavailable", 502); }
  if (response.status >= 500) throw appError("github_unavailable", 502);
  if (response.status === 429) throw appError("github_rate_limit_exceeded", 429);
  const data = await response.json().catch(() => null) as AppTokenResponse | null;
  if (!response.ok || !data || typeof data.access_token !== "string" || !data.access_token ||
      typeof data.refresh_token !== "string" || !data.refresh_token ||
      !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
      !Number.isFinite(data.refresh_token_expires_in) || data.refresh_token_expires_in <= 0) {
    throw appError("github_app_reconnect_required", 401);
  }
  return data;
}
function tokenFields(ownerId: string, data: AppTokenResponse) {
  const cipher = credentialCipher();
  return { encryptedToken: cipher.encrypt(data.access_token, ownerId, APP_PROVIDER),
    encryptedRefreshToken: cipher.encrypt(data.refresh_token, ownerId, APP_PROVIDER, "encryptedRefreshToken"),
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    refreshExpiresAt: new Date(Date.now() + data.refresh_token_expires_in * 1000),
    revision: randomUUID(), revoked: false, updatedAt: new Date() };
}
export async function saveAppGrant(ownerId: string, data: AppTokenResponse) {
  await CredentialModel.updateOne({ ownerId, provider: APP_PROVIDER }, {
    $set: tokenFields(ownerId, data), $unset: { refreshLock: "", refreshLockUntil: "" },
  }, { upsert: true, runValidators: true });
  await UserModel.updateOne({ _id: ownerId }, { $set: { repositories: [] } });
}

export async function appUserToken(ownerId: string): Promise<string> {
  if (!config.GITHUB_APP_ENABLED) throw appError("github_app_disabled", 503);
  const user = await UserModel.findById(ownerId).select("status externalIDs").lean();
  if (!user || user.status === "removed" || user.status === "banned") throw appError();
  // MongoDB lock serializes refresh across API processes and streamers. Conditional
  // writes cannot replace a newer login or revive a grant revoked during refresh.
  for (let attempt = 0; attempt < 30; attempt++) {
    const row = await CredentialModel.findOne({ ownerId, provider: APP_PROVIDER })
      .select("+encryptedToken +encryptedRefreshToken").lean();
    if (!row || row.revoked) throw appError();
    if (row.expiresAt && row.expiresAt.getTime() > Date.now() + 60000) {
      return credentialCipher().decrypt(row.encryptedToken, ownerId, APP_PROVIDER);
    }
    if (!row.encryptedRefreshToken || !row.refreshExpiresAt || row.refreshExpiresAt.getTime() <= Date.now()) throw appError();
    const lock = randomUUID();
    const acquired = await CredentialModel.updateOne({ _id: row._id, revision: row.revision, revoked: { $ne: true },
      $or: [{ refreshLockUntil: { $exists: false } }, { refreshLockUntil: { $lt: new Date() } }] },
    { $set: { refreshLock: lock, refreshLockUntil: new Date(Date.now() + 30000) } });
    if (!acquired.modifiedCount) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
    try {
      const refreshed = await exchangeAppToken({ grant_type: "refresh_token",
        refresh_token: credentialCipher().decrypt(row.encryptedRefreshToken, ownerId, APP_PROVIDER, "encryptedRefreshToken") });
      const saved = await CredentialModel.updateOne({ _id: row._id, revision: row.revision, refreshLock: lock, revoked: { $ne: true } },
        { $set: tokenFields(ownerId, refreshed), $unset: { refreshLock: "", refreshLockUntil: "" } });
      if (saved.modifiedCount) return refreshed.access_token;
    } finally {
      await CredentialModel.updateOne({ _id: row._id, refreshLock: lock }, { $unset: { refreshLock: "", refreshLockUntil: "" } });
    }
  }
  throw appError("github_app_refresh_busy", 503);
}

// Replayed revocations must never invalidate a newer, working authorization.
export async function reconcileAppGrant(ownerId: string) {
  const row = await CredentialModel.findOne({ ownerId, provider: APP_PROVIDER }).lean();
  if (!row || row.revoked) return;
  try {
    const token = await appUserToken(ownerId);
    await githubRequest("/user", token);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "github_app_reconnect_required") throw error;
    await CredentialModel.updateOne({ _id: row._id, revision: row.revision },
      { $set: { revoked: true, revision: randomUUID() } });
  }
}

// Pending reconciliation is durable and retried on access after upstream failures.
// The revision guard prevents an older response from undoing a newer webhook.
export async function reconcileInstallation(installationId: number, revision: string) {
  const current = await githubRequest<AppInstallation>(`/app/installations/${installationId}`, appJWT());
  if (String(current.app_id) !== config.GITHUB_APP_ID) throw appError();
  await InstallationModel.updateOne({ appId: config.GITHUB_APP_ID, installationId, revision },
    { $set: { blocked: !!current.suspended_at, reconciliationPending: false,
      accountId: current.account.id, accountLogin: current.account.login, accountType: current.account.type,
      checkedAt: new Date(), revision: randomUUID() } });
}

export interface GitHubRepositoryInfo {
  id: number; full_name: string; name: string; private: boolean; html_url: string; size: number;
  default_branch: string; owner: { id: number; login: string };
}
export interface AppInstallation {
  id: number; app_id: number; suspended_at: string | null;
  account: { id: number; login: string; type: string };
  permissions: Record<string, string>;
}
export async function userInstallations(ownerId: string): Promise<AppInstallation[]> {
  const token = await appUserToken(ownerId);
  const result: AppInstallation[] = [];
  for (let page = 1; ; page++) {
    const data = await githubRequest<{ installations: AppInstallation[] }>(`/user/installations?per_page=100&page=${page}`, token);
    result.push(...data.installations.filter(i => String(i.app_id) === config.GITHUB_APP_ID));
    if (data.installations.length < 100) break;
  }
  return result;
}
export async function appRepositories(ownerId: string) {
  const installations = await userInstallations(ownerId);
  const token = await appUserToken(ownerId);
  const results: (GitHubRepositoryInfo & { installationId: number })[] = [];
  for (const installation of installations) {
    if (installation.suspended_at) continue;
    for (let page = 1; ; page++) {
      const data = await githubRequest<{ repositories: GitHubRepositoryInfo[] }>(
        `/user/installations/${installation.id}/repositories?per_page=100&page=${page}`, token);
      results.push(...data.repositories.map(r => ({ ...r, installationId: installation.id })));
      if (data.repositories.length < 100) break;
    }
  }
  return results;
}

const installationTokens = new Map<string, { token: string; expires: number }>();
const minting = new Map<string, Promise<string>>();
export function clearAppTokenCache() { installationTokens.clear(); }
async function installationToken(binding: RepositoryAccess, ownerId: string): Promise<string> {
  const id = binding.installationId;
  let local = await InstallationModel.findOne({ appId: config.GITHUB_APP_ID, installationId: id }).lean();
  if (local?.reconciliationPending && local.revision) {
    await reconcileInstallation(id!, local.revision);
    local = await InstallationModel.findOne({ appId: config.GITHUB_APP_ID, installationId: id }).lean();
  }
  if (local?.blocked) throw appError("github_app_access_required");
  const key = `${ownerId}:${id}:${binding.repositoryId}:${local?.revision || ""}`;
  const cached = installationTokens.get(key);
  if (cached && cached.expires > Date.now() + 60000) return cached.token;
  if (minting.has(key)) return minting.get(key)!;
  const work = (async () => {
    const jwt = appJWT();
    const installation = await githubRequest<AppInstallation>(`/app/installations/${id}`, jwt);
    if (String(installation.app_id) !== config.GITHUB_APP_ID || installation.suspended_at || installation.permissions.contents !== "read") {
      throw appError("github_app_access_required");
    }
    // Refuse accidentally configured write permissions instead of presenting a
    // misleading read-only connection to the user.
    if (Object.values(installation.permissions).some(p => p === "write" || p === "admin")) throw appError("github_app_permissions_invalid");
    const permissions: Record<string, string> = { contents: "read", metadata: "read" };
    for (const p of ["pull_requests", "pages"]) if (installation.permissions[p] === "read") permissions[p] = "read";
    const issued = await githubRequest<{ token: string; expires_at: string }>(`/app/installations/${id}/access_tokens`, jwt, "POST",
      { repository_ids: [binding.repositoryId], permissions });
    const expires = Date.parse(issued.expires_at);
    if (!issued.token || !Number.isFinite(expires)) throw appError();
    // Bound memory and ensure a revocation that races minting is observed before use.
    if (installationTokens.size >= 1000) installationTokens.clear();
    const current = await InstallationModel.findOne({ appId: config.GITHUB_APP_ID, installationId: id }).lean();
    if (current?.blocked || current?.revision !== local?.revision) throw appError("github_app_access_required");
    installationTokens.set(key, { token: issued.token, expires });
    return issued.token;
  })();
  minting.set(key, work);
  try { return await work; } finally { minting.delete(key); }
}

export async function boundAppToken(ownerId: string, binding: RepositoryAccess): Promise<string> {
  if (!Number.isSafeInteger(binding.repositoryId) || !Number.isSafeInteger(binding.installationId)) throw appError();
  const userToken = await appUserToken(ownerId);
  // User token checks the intersection of user and App rights on every access.
  // No indefinite local authorization cache can preserve a departed user's access.
  await githubRequest<GitHubRepositoryInfo>(`/repositories/${binding.repositoryId}`, userToken);
  const token = await installationToken(binding, ownerId);
  registerGitHubToken(token, { quotaKey: `installation:${binding.installationId}`, renew: async (force) => {
    if (force) clearAppTokenCache();
    return boundAppToken(ownerId, binding);
  } });
  return token;
}

export async function selectRepositoryAccess(ownerId: string, fullName: string, choice?: unknown): Promise<{ token: string; binding: RepositoryAccess }> {
  if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) throw appError("repo_not_found", 400);
  if (choice !== undefined && choice !== "oauth" && choice !== "github-app") throw appError("invalid_connection", 400);
  const hasApp = config.GITHUB_APP_ENABLED && await CredentialModel.exists({ ownerId, provider: APP_PROVIDER });
  if (choice === "github-app" || (choice === undefined && hasApp)) {
    const repo = (await appRepositories(ownerId)).find(r => r.full_name.toLowerCase() === fullName.toLowerCase());
    if (!repo) throw appError("github_app_access_required");
    const binding: RepositoryAccess = { kind: "github-app", repositoryId: repo.id, installationId: repo.installationId, revision: randomUUID() };
    return { binding, token: await boundAppToken(ownerId, binding) };
  }
  const token = await getCredentialToken(ownerId);
  if (!token) throw appError("github_oauth_required");
  return { token, binding: { kind: "oauth", revision: randomUUID() } };
}

export function installationURL(targetId?: number, repositoryIds: number[] = []) {
  const base = `https://github.com/apps/${encodeURIComponent(config.GITHUB_APP_SLUG)}/installations/new`;
  if (!targetId || !repositoryIds.length) return base;
  const url = new URL(`${base}/permissions`);
  url.searchParams.set("suggested_target_id", String(targetId));
  for (const id of repositoryIds.slice(0, 100)) url.searchParams.append("repository_ids[]", String(id));
  return url.toString();
}
