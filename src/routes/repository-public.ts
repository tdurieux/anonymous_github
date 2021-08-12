import * as express from "express";

import * as db from "../database/database";
import { getRepo, getUser, handleError } from "./route-utils";

const router = express.Router();

router.get("/:repoId/", async (req: express.Request, res: express.Response) => {
  const repo = await getRepo(req, res, { nocheck: true });
  if (!repo) return;

  try {
    res.json((await db.getRepository(req.params.repoId)).toJSON());
  } catch (error) {
    handleError(error, res);
  }
});

router.get(
  "/:repoId/zip",
  async (req: express.Request, res: express.Response) => {
    const repo = await getRepo(req, res);
    if (!repo) return;

    try {
      res.attachment(`${repo.repoId}.zip`);
      repo.zip().pipe(res);
    } catch (error) {
      handleError(error, res);
    }
  }
);

router.get(
  "/:repoId/files",
  async (req: express.Request, res: express.Response) => {
    const repo = await getRepo(req, res);
    if (!repo) return;
    try {
      res.json(await repo.anonymizedFiles({ force: true }));
    } catch (error) {
      handleError(error, res);
    }
  }
);

router.get(
  "/:repoId/options",
  async (req: express.Request, res: express.Response) => {
    const repo = await getRepo(req, res);
    if (!repo) return;

    try {
      await repo.updateIfNeeded();
      res.json(repo.options);
    } catch (error) {
      handleError(error, res);
    }
  }
);

export default router;
