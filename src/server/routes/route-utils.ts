import * as express from "express";
import AnonymousError from "../../core/AnonymousError";
import * as db from "../database";
import UserModel from "../../core/model/users/users.model";
import User from "../../core/User";
import Repository from "../../core/Repository";
import { HTTPError } from "got";
import { RepositoryStatus } from "../../core/types";
import { createLogger, serializeError } from "../../core/logger";
import { isDisabledAccount } from "./auth-utils";

const logger = createLogger("route");

export async function getGist(
  req: express.Request,
  res: express.Response,
  opt?: { nocheck?: boolean }
) {
  try {
    const gist = await db.getGist(req.params.gistId);
    if (opt?.nocheck !== true) {
      if (
        gist.status == "expired" &&
        gist.options.expirationMode == "redirect"
      ) {
        res.redirect(`https://gist.github.com/${gist.source.gistId}`);
        return null;
      }

      await gist.check();
    }
    return gist;
  } catch (error) {
    handleError(error, res, req);
    return null;
  }
}

export async function getPullRequest(
  req: express.Request,
  res: express.Response,
  opt?: { nocheck?: boolean }
) {
  try {
    const pullRequest = await db.getPullRequest(req.params.pullRequestId);
    if (opt?.nocheck !== true) {
      // redirect if the repository is expired
      if (
        pullRequest.status == "expired" &&
        pullRequest.options.expirationMode == "redirect"
      ) {
        res.redirect(
          `https://github.com/${pullRequest.source.repositoryFullName}/pull/${pullRequest.source.pullRequestId}`
        );
        return null;
      }

      await pullRequest.check();
    }
    return pullRequest;
  } catch (error) {
    handleError(error, res, req);
    return null;
  }
}

export async function getRepo(
  req: express.Request,
  res: express.Response,
  opt: { nocheck?: boolean } = {
    nocheck: false,
  }
) {
  try {
    const repo = await db.getRepository(req.params.repoId);
    if (opt.nocheck !== true) {
      // redirect if the repository is expired
      if (
        repo.status == RepositoryStatus.EXPIRED &&
        repo.options.expirationMode == "redirect" &&
        repo.model.source.repositoryId
      ) {
        res.redirect(`https://github.com/${repo.model.source.repositoryName}`);
        return null;
      }

      await repo.check();
    }
    return repo;
  } catch (error) {
    handleError(error, res, req);
    return null;
  }
}

export function isOwnerOrAdmin(authorizedUsers: string[], user: User) {
  if (authorizedUsers.indexOf(user.model.id) == -1 && !user.isAdmin) {
    throw new AnonymousError("not_authorized", {
      httpStatus: 401,
    });
  }
}

export function isCoauthor(repo: Repository, user: User): boolean {
  const githubId = user.model.externalIDs?.github;
  return (repo.model.coauthors || []).some((coauthor) => {
    if (coauthor.githubId) {
      return Boolean(githubId && coauthor.githubId === githubId);
    }
    return Boolean(user.username && coauthor.username === user.username);
  });
}

export function isOwnerCoauthorOrAdmin(repo: Repository, user: User) {
  if (user.isAdmin) return;
  if (repo.owner.id === user.model.id) return;
  if (isCoauthor(repo, user)) return;
  throw new AnonymousError("not_authorized", {
    httpStatus: 403,
  });
}

// Pull the first project-relevant frame ("file:line:col") out of a stack so
// background-job errors (no req.originalUrl) still get a debug pointer in the
// `url` slot. Skips node internals and node_modules.
function originFromStack(stack: unknown): string | undefined {
  if (typeof stack !== "string") return undefined;
  const lines = stack.split("\n");
  for (const line of lines) {
    const m = line.match(/\(([^()\s]+:\d+:\d+)\)\s*$/) ||
      line.match(/at\s+([^()\s]+:\d+:\d+)\s*$/);
    if (!m) continue;
    const loc = m[1];
    if (loc.startsWith("node:") || loc.includes("node_modules")) continue;
    return loc;
  }
  return undefined;
}

function ensureUrl(
  payload: Record<string, unknown>,
  req?: express.Request
) {
  if (req?.originalUrl) {
    payload.url = req.originalUrl;
    return;
  }
  if (typeof payload.url === "string" && payload.url) return;
  const origin = originFromStack(payload.stack);
  if (origin) payload.url = origin;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function printError(error: any, req?: express.Request) {
  if (error instanceof AnonymousError) {
    if (req?.originalUrl === "/api/repo/undefined/options") return;
    const payload: Record<string, unknown> = serializeError(error);
    ensureUrl(payload, req);
    // Use the error's snake_case message as the logger summary so the admin
    // Errors page surfaces something meaningful (e.g. "repoId_already_used")
    // instead of a generic "anonymous error" wrapper.
    const summary = error.message || error.name || "AnonymousError";
    // 4xx are expected client errors (not_found, expired, not_connected) —
    // route them to warn so the admin Errors page can split server faults
    // (5xx) from client misuse (4xx) cleanly.
    const status = error.httpStatus;
    if (typeof status === "number" && status >= 400 && status < 500) {
      logger.warn(summary, payload);
    } else {
      logger.error(summary, payload);
    }
  } else if (error instanceof HTTPError) {
    const payload: Record<string, unknown> = serializeError(error);
    ensureUrl(payload, req);
    logger.error(error.code || error.name || "HTTPError", payload);
  } else {
    // Unhandled errors: use the error class name (SyntaxError, TypeError,
    // RangeError, ...) as the summary so the admin page shows
    // something far more useful than a generic "unhandled error" label.
    const serialized = serializeError(error) as Record<string, unknown>;
    if (
      typeof serialized.status !== "number" &&
      typeof serialized.httpStatus !== "number"
    ) {
      serialized.httpStatus = 500;
    }
    ensureUrl(serialized, req);
    const summary =
      (error && typeof error === "object" &&
        ((error as { name?: string }).name ||
          (error as { message?: string }).message)) ||
      "UnhandledError";
    logger.error(summary, serialized);
  }
}

export function handleError(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: any,
  res?: express.Response,
  req?: express.Request
) {
  printError(error, req);
  let errorCode = error;
  if (error instanceof Error) {
    errorCode = error.message;
  } else if (typeof error !== "string") {
    errorCode = String(error);
  }
  let status = 500;
  if (error.httpStatus) {
    status = error.httpStatus;
  } else if (error.$metadata?.httpStatusCode) {
    status = error.$metadata.httpStatusCode;
  } else if (
    errorCode &&
    (errorCode.indexOf("not_found") > -1 ||
      errorCode.indexOf("(Not Found)") > -1)
  ) {
    status = 404;
  } else if (errorCode && errorCode.indexOf("not_connected") > -1) {
    status = 401;
  }
  if (res && !res.headersSent) {
    const safeCode =
      error instanceof AnonymousError ? errorCode : "internal_error";
    const body: Record<string, unknown> = { error: safeCode };
    if (
      error instanceof AnonymousError &&
      safeCode === "rate_limited" &&
      error.value &&
      typeof error.value === "object" &&
      "resetAt" in (error.value as Record<string, unknown>)
    ) {
      body.resetAt = (error.value as Record<string, unknown>).resetAt;
    }
    res.status(status).json(body);
  }
  return;
}

export async function getUser(req: express.Request) {
  function notConnected(): never {
    req.logout((error) => {
      if (error) {
        logger.error("logout failed", serializeError(error));
      }
    });
    throw new AnonymousError("not_connected", {
      httpStatus: 401,
    });
  }
  if (!req.user) {
    notConnected();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (req.user as any).user;
  if (!user) {
    notConnected();
  }
  const model = await UserModel.findById(user._id);
  if (!model) {
    notConnected();
  }
  if (isDisabledAccount(model.status)) {
    req.logout((error) => {
      if (error) {
        logger.error("logout failed", serializeError(error));
      }
    });
    throw new AnonymousError(
      model.status === "banned" ? "user_banned" : "not_connected",
      {
        httpStatus: model.status === "banned" ? 403 : 401,
      }
    );
  }
  return new User(model);
}
