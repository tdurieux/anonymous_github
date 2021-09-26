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
    const pipeline = promisify(stream.pipeline);

    try {
      if (!config.ENABLE_DOWNLOAD) {
        throw new AnonymousError("download_not_enabled", {
          httpStatus: 403,
          object: req.params.repoId,
        });
      }
      const repo = await getRepo(req, res);
      if (!repo) return;

      if (repo.source.type != "GitHubDownload") {
        throw new AnonymousError("download_not_enabled", {
          httpStatus: 403,
          object: req.params.repoId,
        });
      }

      res.attachment(`${repo.repoId}.zip`);

      // cache the file for 6 hours
      res.header("Cache-Control", "max-age=21600");
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
      res.header("Cache-Control", "no-cache");

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
          throw new AnonymousError("repository_expired", {
            object: repo,
            httpStatus: 410,
          });
        }

        const fiveMinuteAgo = new Date();
        fiveMinuteAgo.setMinutes(fiveMinuteAgo.getMinutes() - 5);
        if (repo.status != "ready") {
          if (
            repo.model.statusDate < fiveMinuteAgo
            // && repo.status != "preparing"
          ) {
            await repo.updateStatus("preparing");
            await downloadQueue.add(repo, { jobId: repo.repoId, attempts: 3 });
          }
          if (repo.status == "error") {
            throw new AnonymousError(
              repo.model.statusMessage
                ? repo.model.statusMessage
                : "repository_not_available",
              {
                object: repo,
                httpStatus: 500,
              }
            );
          }
          throw new AnonymousError("repository_not_ready", {
            httpStatus: 404,
            object: repo,
          });
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

      res.header("Cache-Control", "no-cache");
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
