import * as express from "express";

import * as db from "../database/database";
import { getRepo, getUser, handleError } from "./route-utils";

const router = express.Router();

router.get("/:repoId/", async (req: express.Request, res: express.Response) => {
  const repo = await getRepo(req, res, { nocheck: true });
  if (!repo) return;
  res.json((await db.getRepository(req.params.repoId)).toJSON());
});

router.get(
  "/:repoId/zip",
  async (req: express.Request, res: express.Response) => {
    const repo = await getRepo(req, res);
    if (!repo) return;
    res.attachment(`${repo.repoId}.zip`);
    repo.zip().pipe(res);
  }
);

router.get(
  "/:repoId/files",
  async (req: express.Request, res: express.Response) => {
    const repo = await getRepo(req, res);
    if (!repo) return;
    res.json(await repo.anonymizedFiles({ force: true }));
  }
);

router.get(
  "/:repoId/options",
  async (req: express.Request, res: express.Response) => {
    const repo = await getRepo(req, res);
    if (!repo) return;
    await repo.updateIfNeeded();
    res.json(repo.options);
  }
);

export default router;
