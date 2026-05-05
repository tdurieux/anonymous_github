import { Octokit } from "@octokit/rest";

import Repository from "./Repository";
import UserModel from "./model/users/users.model";
import config from "../config";

export function octokit(token: string) {
  return new Octokit({
    auth: token,
    request: {
      fetch: fetch,
    },
  });
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
  console.log("getToken", repository.repoId);
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
          await repository.owner.model.save();
          return refreshed;
        }
      }
      console.warn(
        `[getToken] refresh failed for ${repository.owner.model.username} (status ${res.status}); falling back`
      );
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
