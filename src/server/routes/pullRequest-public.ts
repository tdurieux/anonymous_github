import * as express from "express";

import { getPullRequest, getUser, handleError } from "./route-utils";
import AnonymousError from "../../core/AnonymousError";
import User from "../../core/User";

const router = express.Router();

router.get(
  "/:pullRequestId/options",
  async (req: express.Request, res: express.Response) => {
    try {
      res.header("Cache-Control", "no-cache");
      const pr = await getPullRequest(req, res, { nocheck: true });
      if (!pr) return;

      let user: User | undefined = undefined;
      try {
        user = await getUser(req);
      } catch { /* not logged in */ }
      const canEdit =
        !!user && (user.isAdmin || user.id == pr.model.owner);

      let redirectURL = null;
      if (!canEdit && pr.status == "expired" && pr.options.expirationMode == "redirect") {
        redirectURL = `https://github.com/${pr.source.repositoryFullName}/pull/${pr.source.pullRequestId}`;
      } else if (!canEdit) {
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
        isAdmin: user?.isAdmin === true,
        isOwner: user?.id == pr.model.owner,
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
