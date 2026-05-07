import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";

import AnonymousError from "./AnonymousError";
import Repository from "./Repository";
import UserModel from "./model/users/users.model";
import config from "../config";
import { createLogger } from "./logger";

const logger = createLogger("github");

// Octokit RequestError shape (subset we care about for rate-limit detection).
interface OctokitRequestErrorLike {
  status?: number;
  message?: string;
  response?: {
    headers?: Record<string, string | undefined>;
  };
}

/**
 * Detect GitHub rate-limit / abuse responses (primary 5k/h or undocumented
 * "secondary" limits) and rewrap them as a translatable AnonymousError so
 * the UI can show a friendly message instead of a raw HttpError stack. The
 * GitHub `x-github-request-id` header is preserved in `detail` so users can
 * cite it if they reach out to GitHub Support.
 */
export function isGitHubRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as OctokitRequestErrorLike;
  const msg = (e.message ?? "").toLowerCase();
  // Primary limits return 403 with "x-ratelimit-remaining: 0"; secondary
  // limits return 403 (sometimes 429) with "secondary rate limit" in the
  // body. Match on either signal so we catch both.
  const status = e.status ?? 0;
  if (status !== 403 && status !== 429) return false;
  if (msg.includes("rate limit") || msg.includes("abuse")) return true;
  const remaining = e.response?.headers?.["x-ratelimit-remaining"];
  return remaining === "0";
}

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

export function octokit(token: string) {
  const oct = new ThrottledOctokit({
    auth: token,
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
        // Retry once; if GitHub is still throttling after that, surface the
        // error to the caller so the UI shows github_rate_limit_exceeded.
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
        return retryCount < 1;
      },
    },
  });
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
  return oct;
}

export async function checkToken(token: string) {
  const oct = octokit(token);
  try {
    await oct.users.getAuthenticated();
    return true;
  } catch {
    return false;
  }
}

export async function getToken(repository: Repository) {
  logger.debug("getToken", { repoId: repository.repoId });
  // if (repository.model.source.accessToken) {
  //   // only check the token if the repo has been visited less than 10 minutes ago
  //   if (
  //     repository.status == RepositoryStatus.READY &&
  //     repository.model.lastView > new Date(Date.now() - 1000 * 60 * 10)
  //   ) {
  //     return repository.model.source.accessToken;
  //   } else if (await checkToken(repository.model.source.accessToken)) {
  //     return repository.model.source.accessToken;
  //   }
  // }
  if (!repository.owner.model.accessTokens?.github) {
    const query = await UserModel.findById(repository.owner.id, {
      accessTokens: 1,
      accessTokenDates: 1,
    });
    if (query?.accessTokens) {
      repository.owner.model.accessTokens = query.accessTokens;
      repository.owner.model.accessTokenDates = query.accessTokenDates;
    }
  }
  const ownerAccessToken = repository.owner.model.accessTokens?.github;
  if (ownerAccessToken) {
    const tokenAge = repository.owner.model.accessTokenDates?.github;
    // if the token is older than 7 days, refresh it
    if (
      !tokenAge ||
      tokenAge < new Date(Date.now() - 1000 * 60 * 60 * 24 * 7)
    ) {
      const url = `https://api.github.com/applications/${config.CLIENT_ID}/token`;
      const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };

      const res = await fetch(url, {
        method: "PATCH",
        body: JSON.stringify({
          access_token: ownerAccessToken,
        }),
        credentials: "include",
        headers: {
          ...headers,
          Authorization:
            "Basic " +
            Buffer.from(
              config.CLIENT_ID + ":" + config.CLIENT_SECRET
            ).toString("base64"),
        },
      });
      // Only persist a refreshed token if GitHub actually returned a
      // valid one. Without this guard, a 4xx/5xx error body (revoked
      // OAuth, rate limit, transient outage) silently overwrites the
      // user's stored token with `undefined`, which then propagates as
      // `Authorization: token undefined` to every subsequent API call —
      // 401 even on public repos, and the config.GITHUB_TOKEN fallback
      // below is unreachable because the token field is no longer falsy.
      if (res.ok) {
        const resBody = (await res.json().catch(() => null)) as
          | { token?: unknown }
          | null;
        const refreshed =
          resBody && typeof resBody.token === "string" && resBody.token.length > 0
            ? resBody.token
            : null;
        if (refreshed) {
          repository.owner.model.accessTokens.github = refreshed;
          if (!repository.owner.model.accessTokenDates) {
            repository.owner.model.accessTokenDates = { github: new Date() };
          } else {
            repository.owner.model.accessTokenDates.github = new Date();
          }
          await UserModel.updateOne(
            { _id: repository.owner.model._id },
            {
              $set: {
                "accessTokens.github": refreshed,
                "accessTokenDates.github":
                  repository.owner.model.accessTokenDates.github,
              },
            }
          ).exec();
          return refreshed;
        }
      }
      logger.warn("token refresh failed; falling back", {
        code: "token_refresh_failed",
        httpStatus: res.status,
        username: repository.owner.model.username,
      });
      // fall through to the checkToken path / config.GITHUB_TOKEN
    }
    const check = await checkToken(ownerAccessToken);
    if (check) {
      repository.model.source.accessToken = ownerAccessToken;
      return ownerAccessToken;
    }
  }
  return config.GITHUB_TOKEN;
}
