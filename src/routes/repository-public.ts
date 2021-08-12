import * as express from "express";
import config from "../../config";

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
    if (!config.ENABLE_DOWNLOAD)
      return res.status(403).send({ error: "download_not_enabled" });
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
      res.json(await repo.anonymizedFiles({ includeSha: false }));
    } catch (error) {
      handleError(error, res);
    }
  }
);

router.get(
  "/:repoId/options",
  async (req: express.Request, res: express.Response) => {
    try {
      const repo = await getRepo(req, res, { nocheck: true });

      let redirectURL = null;
      if (
        repo.status == "expired" &&
        repo.options.expirationMode == "redirect" &&
        repo.source.url
      ) {
        redirectURL = repo.source.url;
      } else {
        repo.check();
      }

      await repo.updateIfNeeded();

      res.json({
        url: redirectURL,
        download: !!config.ENABLE_DOWNLOAD,
      });
    } catch (error) {
      handleError(error, res);
    }
  }
);

export default router;
