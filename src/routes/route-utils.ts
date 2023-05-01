import * as express from "express";
import AnonymousError from "../AnonymousError";
import * as db from "../database/database";
import UserModel from "../database/users/users.model";
import User from "../User";
import * as io from "@pm2/io";

export async function getPullRequest(
  req: express.Request,
  res: express.Response,
  opt?: { nocheck?: boolean }
) {
  try {
    const pullRequest = await db.getPullRequest(req.params.pullRequestId);
    if (opt?.nocheck == true) {
    } else {
      // redirect if the repository is expired
      if (
        pullRequest.status == "expired" &&
        pullRequest.options.expirationMode == "redirect"
      ) {
        res.redirect(
          `http://github.com/${pullRequest.source.repositoryFullName}/pull/${pullRequest.source.pullRequestId}`
        );
        return null;
      }

      pullRequest.check();
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
  opt: { nocheck?: boolean; includeFiles?: boolean } = {
    nocheck: false,
    includeFiles: false,
  }
) {
  try {
    const repo = await db.getRepository(req.params.repoId, {
      includeFiles: opt.includeFiles === true,
    });
    if (opt.nocheck == true) {
    } else {
      // redirect if the repository is expired
      if (
        repo.status == "expired" &&
        repo.options.expirationMode == "redirect" &&
        repo.source.url
      ) {
        res.redirect(repo.source.url);
        return null;
      }

      repo.check();
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

function printError(error: any, req?: express.Request) {
  io.notifyError(error, error.value);
  if (error instanceof AnonymousError) {
    let message = `[ERROR] ${error.toString()} ${error.stack
      ?.split("\n")[1]
      .trim()}`;
    if (req) {
      message += ` ${req.originalUrl}`;
      // ignore common error
      if (req.originalUrl === "/api/repo/undefined/options") return;
    }
    console.error(message);
  } else if (error instanceof Error) {
    console.error(error);
  } else {
    console.error(error);
  }
}

export function handleError(
  error: any,
  res?: express.Response,
  req?: express.Request
) {
  printError(error, req);
  let message = error;
  if (error instanceof Error) {
    message = error.message;
  }
  let status = 500;
  if (error.httpStatus) {
    status = error.httpStatus;
  } else if (error.$metadata?.httpStatusCode) {
    status = error.$metadata.httpStatusCode;
  } else if (message && message.indexOf("not_found") > -1) {
    status = 404;
  } else if (message && message.indexOf("not_connected") > -1) {
    status = 401;
  }
  if (res && !res.headersSent) {
    res.status(status).send({ error: message });
  }
  return;
}

export async function getUser(req: express.Request) {
  function notConnected(): never {
    req.logout((error) => {
      if (error) {
        console.error(`[ERROR] Error while logging out: ${error}`);
      }
    });
    throw new AnonymousError("not_connected", {
      httpStatus: 401,
    });
  }
  if (!req.user) {
    notConnected();
  }
  const user = (req.user as any).user;
  if (!user) {
    notConnected();
  }
  const model = await UserModel.findById(user._id);
  if (!model) {
    notConnected();
  }
  return new User(model);
}
