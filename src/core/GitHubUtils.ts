import { trace } from "@opentelemetry/api";
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
  } catch (error) {
    return false;
  }
}

export async function getToken(repository: Repository) {
  const span = trace.getTracer("ano-file").startSpan("GHUtils.getToken");
  span.setAttribute("repoId", repository.repoId);
  try {
    // only check the token if the repo has been visited more than one day ago
    if (
      repository.model.source.accessToken &&
      repository.model.lastView > new Date(Date.now() - 1000 * 60 * 60 * 24)
    ) {
      return repository.model.source.accessToken;
    }
    if (repository.model.source.accessToken) {
      if (await checkToken(repository.model.source.accessToken)) {
        return repository.model.source.accessToken;
      }
    }
    if (!repository.owner.model.accessTokens?.github) {
      const accessTokens = (
        await UserModel.findById(repository.owner.id, {
          accessTokens: 1,
        })
      )?.accessTokens;
      if (accessTokens) {
        repository.owner.model.accessTokens = accessTokens;
      }
    }
    if (repository.owner.model.accessTokens?.github) {
      const check = await checkToken(
        repository.owner.model.accessTokens?.github
      );
      if (check) {
        repository.model.source.accessToken =
          repository.owner.model.accessTokens?.github;
        return repository.owner.model.accessTokens?.github;
      }
    }
    return config.GITHUB_TOKEN;
  } finally {
    span.end();
  }
}
