import * as express from "express";
import AnonymizedFile from "../AnonymizedFile";
import AnonymousError from "../AnonymousError";
import * as db from "../database/database";
import UserModel from "../database/users/users.model";
import Repository from "../Repository";
import GitHubBase from "../source/GitHubBase";
import GitHubDownload from "../source/GitHubDownload";
import { GitHubRepository } from "../source/GitHubRepository";
import User from "../User";

export async function getRepo(
  req: express.Request,
  res: express.Response,
  opt?: { nocheck?: boolean }
) {
  try {
    const repo = await db.getRepository(req.params.repoId);
    if (opt?.nocheck == true) {
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
    handleError(error, res);
    return null;
  }
}

function printError(error: any) {
  if (error instanceof AnonymousError) {
    let detail = error.value?.toString();
    if (error.value instanceof Repository) {
      detail = error.value.repoId;
    } else if (error.value instanceof AnonymizedFile) {
      detail = `/r/${error.value.repository.repoId}/${error.value.anonymizedPath}`;
    } else if (error.value instanceof GitHubRepository) {
      detail = `${error.value.fullName}`;
    } else if (error.value instanceof User) {
      detail = `${error.value.username}`;
    } else if (error.value instanceof GitHubBase) {
      detail = `${error.value.repository.repoId}`;
    }
    console.error(
      "[ERROR]",
      error.message,
      `'${detail}'`,
      error.stack.split("\n")[1].trim()
    );
  } else if (error instanceof Error) {
    console.error(error);
  } else {
    console.error(error);
  }
}

export function handleError(error: any, res: express.Response) {
  printError(error);
  let message = error;
  if (error instanceof Error) {
    message = error.message;
  }
  let status = 500;
  if (message && message.indexOf("not_found") > -1) {
    status = 400;
  } else if (message && message.indexOf("not_connected") > -1) {
    status = 401;
  }

  res.status(status).send({ error: message });
  return;
}

export async function getUser(req: express.Request) {
  const user = (req.user as any).user;
  if (!user) {
    req.logout();
    throw new AnonymousError("not_connected");
  }
  const model = await UserModel.findById(user._id);
  if (!model) {
    req.logout();
    throw new AnonymousError("not_connected");
  }
  return new User(model);
}
