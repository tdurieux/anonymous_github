import * as express from "express";
import config from "../../config";

import * as db from "../database/database";
import { getRepo, handleError } from "./route-utils";

const router = express.Router();

router.get(
  "/:repoId/zip",
  async (req: express.Request, res: express.Response) => {
    if (!config.ENABLE_DOWNLOAD)
      return res.status(403).send({ error: "download_not_enabled" });
    const repo = await getRepo(req, res);
    if (!repo) return;

    try {
      res.attachment(`${repo.repoId}.zip`);

      // ache the file for 6 hours
      res.header("Cache-Control", "max-age=21600000");

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
      // ache the file for 6 hours
      res.header("Cache-Control", "max-age=21600000");

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
      if (!repo) return;
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

      let download = false;
      const conference = await repo.conference();
      if (conference) {
        download =
          conference.quota.size > -1 &&
          !!config.ENABLE_DOWNLOAD &&
          repo.source.type == "GitHubDownload";
      }

      res.json({
        url: redirectURL,
        download,
      });
    } catch (error) {
      handleError(error, res);
    }
  }
);

export default router;
