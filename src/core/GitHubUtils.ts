import { isGitHubRateLimitError, OctokitRequestErrorLike } from "./github-rate-limit";
import { refreshLegacyToken } from "./legacy-token-refresh";
import { notifyOwnerAccessProblem } from "./owner-notifications";
import AnonymizedRepositoryModel from "./model/anonymizedRepositories/anonymizedRepositories.model";
import { isConnected } from "../server/database";
import { githubQuotaKey, githubTokenContext } from "./github-token-context";
import { boundAppToken } from "./github-app";
import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import { createClient, RedisClientType } from "redis";

import AnonymousError from "./AnonymousError";
import Repository from "./Repository";
import { getCredential, getCredentialToken } from "./credentials";
import config from "../config";
import { createLogger } from "./logger";
import { measureStage } from "./request-monitoring";
import { setTimeout as delay } from "timers/promises";

const logger = createLogger("github");

export { isGitHubRateLimitError } from "./github-rate-limit";

function rateLimitDetail(err: OctokitRequestErrorLike): string {
  const headers = err.response?.headers ?? {};
  const requestId = headers["x-github-request-id"];
  const retryAfter = headers["retry-after"];
  const reset = headers["x-ratelimit-reset"];
  const parts: string[] = [];
  if (requestId) parts.push(`requestId=${requestId}`);
  if (retryAfter) parts.push(`retryAfter=${retryAfter}s`);
  if (reset) parts.push(`reset=${reset}`);
  return parts.join(" ");
}

const ThrottledOctokit = Octokit.plugin(throttling);

/**
 * Per-token gate that blocks all callers when a rate limit is active.
 * When any request for a given token hits a rate limit, the gate records
 * the reset time and makes every subsequent caller wait until then —
 * preventing a stampede of doomed requests.
 */
const tokenGates = new Map<string, { resetAt: number }>();

function setTokenGate(token: string, retryAfterSec: number) {
  const key = githubQuotaKey(token);
  const resetAt = Date.now() + retryAfterSec * 1000;
  const existing = tokenGates.get(key);
  if (!existing || resetAt > existing.resetAt) {
    tokenGates.set(key, { resetAt });
    logger.warn("rate limit gate set", {
      code: "rate_limit_gate",
      tokenKey: key,
      retryAfterSec,
      resetAt: new Date(resetAt).toISOString(),
    });
    setRedisGate(key, retryAfterSec).catch(() => {});
  }
}

export class RateLimitDelayError extends Error {
  resetAt: number;
  tokenKey: string;
  constructor(resetAt: number, tokenKey: string) {
    const delaySec = Math.ceil((resetAt - Date.now()) / 1000);
    super(`github_rate_limit_delay:${delaySec}s`);
    this.name = "RateLimitDelayError";
    this.resetAt = resetAt;
    this.tokenKey = tokenKey;
  }
}

/**
 * Check if a rate limit gate is active for a token.
 * Returns the reset timestamp, or 0 if no gate is active.
 */
export function getTokenGateResetAt(token: string): number {
  const key = githubQuotaKey(token);
  const gate = tokenGates.get(key);
  if (!gate) return 0;
  if (gate.resetAt <= Date.now()) {
    tokenGates.delete(key);
    return 0;
  }
  return gate.resetAt;
}

function abortableGateLookup(lookup: Promise<number>, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const cancelled = () => { signal.removeEventListener("abort", cancelled); reject(signal.reason); };
    if (signal.aborted) cancelled();
    else signal.addEventListener("abort", cancelled, { once: true });
    lookup.then(value => { signal.removeEventListener("abort", cancelled); resolve(value); },
      error => { signal.removeEventListener("abort", cancelled); reject(error); });
  });
}

async function waitForTokenGate(token: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const key = githubQuotaKey(token);
  const localGate = tokenGates.get(key);
  let waitMs = 0;
  let resetAt = 0;

  if (localGate && localGate.resetAt > Date.now()) {
    resetAt = localGate.resetAt;
    waitMs = resetAt - Date.now();
  }

  const lookup = getRedisGateResetAt(key);
  const redisResetAt = await (signal ? abortableGateLookup(lookup, signal) : lookup);
  signal?.throwIfAborted();
  if (redisResetAt > resetAt) {
    resetAt = redisResetAt;
    waitMs = resetAt - Date.now();
  }

  if (waitMs <= 0) {
    if (localGate) tokenGates.delete(key);
    return;
  }

  logger.info("waiting for rate limit gate", {
    code: "rate_limit_gate_wait",
    waitMs,
    resetAt: new Date(resetAt).toISOString(),
  });
  await delay(waitMs, undefined, { signal });
  if (localGate) tokenGates.delete(key);
}

const REDIS_GATE_PREFIX = "gh_rate_gate:";

let redisGateDisabled = false;
let redisGateReady: Promise<RedisClientType | null> | null = null;

function ensureRedisGateClient(): Promise<RedisClientType | null> {
  if (redisGateDisabled) return Promise.resolve(null);
  if (redisGateReady) return redisGateReady;
  redisGateReady = (async () => {
    try {
      const c = createClient({
        socket: {
          host: config.REDIS_HOSTNAME,
          port: config.REDIS_PORT,
          reconnectStrategy: false,
        },
      }) as RedisClientType;
      c.on("error", () => {
        redisGateDisabled = true;
        if (c.isOpen) c.destroy();
        redisGateReady = null;
      });
      await c.connect();
      return c;
    } catch {
      redisGateDisabled = true;
      redisGateReady = null;
      return null;
    }
  })();
  return redisGateReady;
}

async function setRedisGate(tokenKey: string, retryAfterSec: number): Promise<void> {
  const c = await ensureRedisGateClient();
  if (!c || !c.isOpen) return;
  const resetAt = Date.now() + retryAfterSec * 1000;
  const ttl = Math.ceil(retryAfterSec) + 10;
  try {
    await c.set(REDIS_GATE_PREFIX + tokenKey, String(resetAt), { EX: ttl });
    logger.info("redis rate limit gate written", {
      code: "redis_gate_set",
      tokenKey,
      resetAt: new Date(resetAt).toISOString(),
      ttl,
    });
  } catch {
    // non-critical
  }
}

export async function setRedisGateFromWorker(tokenKey: string, resetAt: number): Promise<void> {
  const retryAfterSec = Math.max(0, (resetAt - Date.now()) / 1000);
  if (retryAfterSec <= 0) return;
  await setRedisGate(tokenKey, retryAfterSec);
}

export async function getRedisGateResetAt(tokenKey: string): Promise<number> {
  const c = await ensureRedisGateClient();
  if (!c || !c.isOpen) return 0;
  try {
    const val = await c.get(REDIS_GATE_PREFIX + tokenKey);
    if (!val) return 0;
    const resetAt = parseInt(val, 10);
    if (isNaN(resetAt) || resetAt <= Date.now()) return 0;
    return resetAt;
  } catch {
    return 0;
  }
}

export function octokit(token: string) {
  const context = githubTokenContext(token);
  const oct = new ThrottledOctokit({
    // Managed App tokens are supplied by the renewal hook. Octokit's static
    // token strategy would otherwise overwrite the renewed Authorization header.
    auth: context ? undefined : token,
    request: {
      fetch: fetch,
    },
    throttle: {
      onRateLimit: (retryAfter, options, _o, retryCount) => {
        logger.warn("github primary rate limit hit", {
          code: "github_rate_limit",
          httpStatus: 429,
          method: options.method,
          url: options.url,
          retryAfter,
          retryCount,
        });
        setTokenGate(token, retryAfter);
        return retryCount < 1;
      },
      onSecondaryRateLimit: (retryAfter, options, _o, retryCount) => {
        logger.warn("github secondary rate limit hit", {
          code: "github_secondary_rate_limit",
          httpStatus: 429,
          method: options.method,
          url: options.url,
          retryAfter,
          retryCount,
        });
        setTokenGate(token, retryAfter);
        return retryCount < 1;
      },
    },
  });
  if (context) {
    oct.hook.before("request", async options => {
      if (context.publicRepository) {
        const url = new URL(oct.request.endpoint(options).url);
        const prefix = `/repos/${context.publicRepository.split("/").map(encodeURIComponent).join("/")}`.toLowerCase();
        const path = url.pathname.toLowerCase();
        const suffix = path.slice(prefix.length);
        const readable = /^(?:\/?|\/branches(?:\/[^/]+)?|\/commits(?:\/[^/]+)?|\/readme|\/pages|\/zipball\/[^/]+|\/git\/(?:trees|blobs)\/[^/]+|\/pulls\/\d+|\/issues\/\d+\/comments)$/.test(suffix);
        if (!readable || (options.method !== "GET" && !(options.method === "HEAD" && suffix.startsWith("/zipball/"))) || url.origin !== "https://api.github.com" ||
            (path !== prefix && !path.startsWith(prefix + "/"))) {
          throw new AnonymousError("github_app_access_required", { httpStatus: 403 });
        }
      }
      options.headers.authorization = `token ${await context.renew()}`;
    });
    oct.hook.wrap("request", async (request, options) => {
      try { return await request(options); }
      catch (error) {
        if ((error as { status?: number }).status !== 401) throw error;
        options.headers.authorization = `token ${await context.renew(true)}`;
        return request(options);
      }
    });
  }
  oct.hook.error("request", (err) => {
    if (isGitHubRateLimitError(err)) {
      throw new AnonymousError("github_rate_limit_exceeded", {
        httpStatus: 429,
        cause: err as Error,
        object: rateLimitDetail(err as OctokitRequestErrorLike),
      });
    }
    throw err;
  });
  oct.hook.wrap("request", (request, options) => measureStage("upstream", async () => request(options)));
  return oct;
}

export { waitForTokenGate };

export async function checkToken(token: string) {
  const oct = octokit(token);
  try {
    const context = githubTokenContext(token);
    if (context?.publicRepository) { await context.renew(); return true; }
    if (token.startsWith("ghs_")) await oct.request("GET /installation/repositories");
    else await oct.users.getAuthenticated();
    return true;
  } catch (err) {
    // Only a confirmed invalid credential permits fallback. Network failures,
    // permission failures and rate limits must retain their original meaning.
    if ((err as { status?: number })?.status !== 401) throw err;
    return false;
  }
}

const checkedRepositoryTokens = new WeakMap<Repository, string>();

export async function getToken(repository: Repository) {
  try {
    return await measureStage("authorization", () => resolveRepositoryToken(repository));
  } catch (error) {
    void notifyOwnerAccessProblem(repository.owner.id, error, { kind: "repository", id: String(repository.model._id) });
    throw error;
  }
}

async function resolveRepositoryToken(repository: Repository) {
  repository.assertNotArchived();
  logger.debug("getToken", { repoId: repository.repoId });
  if (isConnected && !repository.model.isNew) {
    const current = await AnonymizedRepositoryModel.findById(repository.model._id).select("owner githubAccess").lean();
    if (!current || String(current.owner) !== repository.owner.id || current.githubAccess?.revision !== repository.model.githubAccess?.revision) {
      throw new AnonymousError("connection_changed", { httpStatus: 409 });
    }
  }
  if (repository.model.githubAccess?.kind === "github-app") {
    return boundAppToken(repository.owner.id, repository.model.githubAccess, repository.model.source.repositoryName);
  }
  const credential = await getCredential(repository.owner.id);
  const ownerAccessToken = credential?.token;
  if (ownerAccessToken) {
    if (checkedRepositoryTokens.get(repository) === ownerAccessToken) {
      return ownerAccessToken;
    }
    const tokenAge = credential?.updatedAt;
    // if the token is older than 7 days, refresh it
    if (
      credential?.persisted &&
      (!tokenAge || tokenAge < new Date(Date.now() - 1000 * 60 * 60 * 24 * 7))
    ) {
      const refreshed = await refreshLegacyToken(repository.owner.id, ownerAccessToken);
      if (refreshed !== null) {
        checkedRepositoryTokens.set(repository, refreshed);
        return refreshed;
      }
    }
    const check = await checkToken(ownerAccessToken);
    if (check) {
      checkedRepositoryTokens.set(repository, ownerAccessToken);
      return ownerAccessToken;
    }
    void notifyOwnerAccessProblem(repository.owner.id, "token_expired", { kind: "repository", id: String(repository.model._id) });
    return config.GITHUB_TOKEN;
  }
  return (await getCredentialToken(repository.owner.id, "github", {
    collection: "anonymizedrepositories", id: repository.model._id,
  })) || config.GITHUB_TOKEN;
}
