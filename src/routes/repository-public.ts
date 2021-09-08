import { promisify } from "util";
import * as express from "express";
import * as stream from "stream";
import config from "../../config";

import { getRepo, handleError } from "./route-utils";
import AnonymousError from "../AnonymousError";
import { downloadQueue } from "../queue";

const router = express.Router();

router.get(
  "/:repoId/zip",
  async (req: express.Request, res: express.Response) => {
    if (!config.ENABLE_DOWNLOAD)
      return res.status(403).send({ error: "download_not_enabled" });
    const repo = await getRepo(req, res);
    if (!repo) return;

    const pipeline = promisify(stream.pipeline);

    try {
      res.attachment(`${repo.repoId}.zip`);

      // cache the file for 6 hours
      res.header("Cache-Control", "max-age=21600000");
      await pipeline(repo.zip(), res);
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
        if (
          repo.status == "expired" ||
          repo.status == "expiring" ||
          repo.status == "removing" ||
          repo.status == "removed"
        ) {
          throw new AnonymousError("repository_expired", this);
        }

        const fiveMinuteAgo = new Date();
        fiveMinuteAgo.setMinutes(fiveMinuteAgo.getMinutes() - 5);
        if (repo.status != "ready") {
          if (
            repo.model.statusDate < fiveMinuteAgo &&
            repo.status != "preparing"
          ) {
            await repo.updateStatus("preparing");
            await downloadQueue.add(this, { jobId: repo.repoId });
          }
          throw new AnonymousError("repository_not_ready", this);
        }

        await repo.updateIfNeeded();
      }

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
