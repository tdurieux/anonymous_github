import * as express from "express";

import { getPullRequest, handleError } from "./route-utils";
import AnonymousError from "../../core/AnonymousError";

const router = express.Router();

router.get(
  "/:pullRequestId/options",
  async (req: express.Request, res: express.Response) => {
    try {
      res.header("Cache-Control", "no-cache");
      const pr = await getPullRequest(req, res, { nocheck: true });
      if (!pr) return;
      let redirectURL = null;
      if (pr.status == "expired" && pr.options.expirationMode == "redirect") {
        redirectURL = `https://github.com/${pr.source.repositoryFullName}/pull/${pr.source.pullRequestId}`;
      } else {
        if (
          pr.status == "expired" ||
          pr.status == "expiring" ||
          pr.status == "removing" ||
          pr.status == "removed"
        ) {
          throw new AnonymousError("pull_request_expired", {
            object: pr,
            httpStatus: 410,
          });
        }

        const fiveMinuteAgo = new Date();
        fiveMinuteAgo.setMinutes(fiveMinuteAgo.getMinutes() - 5);
        if (pr.status != "ready") {
          if (
            pr.model.statusDate < fiveMinuteAgo
            // && repo.status != "preparing"
          ) {
            await pr.updateIfNeeded({ force: true });
          }
          if (pr.status == "error") {
            throw new AnonymousError(
              pr.model.statusMessage
                ? pr.model.statusMessage
                : "pull_request_not_available",
              {
                object: pr,
                httpStatus: 500,
              }
            );
          }
          throw new AnonymousError("pull_request_not_ready", {
            httpStatus: 404,
            object: pr,
          });
        }

        await pr.updateIfNeeded();
      }

      res.json({
        url: redirectURL,
        lastUpdateDate: pr.model.statusDate,
      });
    } catch (error) {
      handleError(error, res, req);
    }
  }
);
router.get(
  "/:pullRequestId/content",
  async (req: express.Request, res: express.Response) => {
    const pullRequest = await getPullRequest(req, res);
    if (!pullRequest) return;
    try {
      await pullRequest.countView();
      res.header("Cache-Control", "no-cache");
      res.json(pullRequest.content());
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

export default router;
