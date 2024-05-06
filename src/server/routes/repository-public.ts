import { promisify } from "util";
import * as express from "express";
import * as stream from "stream";
import config from "../../config";
import got from "got";
import { join } from "path";

import { getRepo, getUser, handleError } from "./route-utils";
import AnonymousError from "../../core/AnonymousError";
import { downloadQueue } from "../../queue";
import { RepositoryStatus } from "../../core/types";
import User from "../../core/User";

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

      let user: User | undefined = undefined;
      try {
        user = await getUser(req);
      } catch (_) {}

      let download = false;
      if (
        (!!config.ENABLE_DOWNLOAD && !!config.STREAMER_ENTRYPOINT) ||
        user?.isAdmin === true
      ) {
        download = true;
      }

      if (!download) {
        throw new AnonymousError("download_not_enabled", {
          httpStatus: 403,
          object: req.params.repoId,
        });
      }

      await repo.countView();

      if (config.STREAMER_ENTRYPOINT) {
        // use the streamer service
        const token = await repo.getToken();
        const anonymizer = repo.generateAnonymizeTransformer("");
        res.attachment(`${repo.repoId}.zip`);
        const reqStream = got
          .stream(join(config.STREAMER_ENTRYPOINT, "api/download"), {
            method: "POST",
            json: {
              token,
              repoFullName: repo.model.source.repositoryName,
              commit: repo.model.source.commit,
              branch: repo.model.source.branch,
              repoId: repo.repoId,
              anonymizerOptions: anonymizer.opt,
            },
          })
          .on("error", () => {
            handleError(
              new AnonymousError("file_not_found", {
                object: this,
                httpStatus: 404,
              }),
              res
            );
          });
        reqStream.pipe(res);
        res.on("close", () => {
          reqStream.destroy();
        });
        res.on("error", () => {
          reqStream.destroy();
        });
        return;
      }

      res.attachment(`${repo.repoId}.zip`);

      // cache the file for 6 hours
      res.header("Cache-Control", "max-age=21600");
      await pipeline(await repo.zip(), res);
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

router.get(
  "/:repoId/files",
  async (req: express.Request, res: express.Response) => {
    res.header("Cache-Control", "no-cache");
    const repo = await getRepo(req, res);
    if (!repo) return;
    try {
      res.json(
        await repo.anonymizedFiles({
          includeSha: false,
          recursive: false,
          path: req.query.path as string,
        })
      );
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

router.get(
  "/:repoId/options",
  async (req: express.Request, res: express.Response) => {
    try {
      res.header("Cache-Control", "no-cache");
      const repo = await getRepo(req, res, {
        nocheck: true,
      });
      if (!repo) return;
      let redirectURL = null;
      if (
        repo.status == RepositoryStatus.EXPIRED &&
        repo.options.expirationMode == "redirect" &&
        repo.model.source.repositoryName
      ) {
        redirectURL = `https://github.com/${repo.model.source.repositoryName}`;
      } else {
        if (
          repo.status == RepositoryStatus.EXPIRED ||
          repo.status == RepositoryStatus.EXPIRING ||
          repo.status == RepositoryStatus.REMOVING ||
          repo.status == RepositoryStatus.REMOVED
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
            await repo.updateStatus(RepositoryStatus.PREPARING);
            await downloadQueue.add(repo.repoId, repo, {
              jobId: repo.repoId,
              attempts: 3,
            });
          }
          if (repo.status == "error") {
            throw new AnonymousError(
              repo.model.statusMessage
                ? repo.model.statusMessage
                : "repository_not_accessible",
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
      if (!!config.ENABLE_DOWNLOAD && !!config.STREAMER_ENTRYPOINT) {
        download = true;
      }

      let user: User | undefined = undefined;
      try {
        user = await getUser(req);
      } catch (_) {}
      res.json({
        url: redirectURL,
        download: download || user?.isAdmin === true,
        lastUpdateDate: repo.model.source.commitDate
          ? repo.model.source.commitDate
          : repo.model.anonymizeDate,
        isAdmin: user?.isAdmin === true,
        isOwner: user?.id == repo.model.owner,
        hasWebsite: !!repo.options.page && !!repo.options.pageSource,
      });
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

export default router;
