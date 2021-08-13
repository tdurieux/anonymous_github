import * as express from "express";
import * as db from "../database/database";
import UserModel from "../database/users/users.model";
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

export function handleError(error: any, res: express.Response) {
  console.log(error);
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
    throw new Error("not_connected");
  }
  const model = await UserModel.findById(user._id);
  if (!model) {
    req.logout();
    throw new Error("not_connected");
  }
  return new User(model);
}
