import * as express from "express";

import { getGist, getUser, handleError } from "./route-utils";
import AnonymousError from "../../core/AnonymousError";
import User from "../../core/User";

const router = express.Router();

router.get(
  "/:gistId/options",
  async (req: express.Request, res: express.Response) => {
    try {
      res.header("Cache-Control", "no-cache");
      const gist = await getGist(req, res, { nocheck: true });
      if (!gist) return;

      let user: User | undefined = undefined;
      try {
        user = await getUser(req);
      } catch { /* not logged in */ }
      const canEdit =
        !!user && (user.isAdmin || user.id == gist.model.owner);

      let redirectURL = null;
      if (
        !canEdit &&
        gist.status == "expired" &&
        gist.options.expirationMode == "redirect"
      ) {
        redirectURL = `https://gist.github.com/${gist.source.gistId}`;
      } else if (!canEdit) {
        if (
          gist.status == "expired" ||
          gist.status == "expiring" ||
          gist.status == "removing" ||
          gist.status == "removed"
        ) {
          throw new AnonymousError("gist_expired", {
            object: gist,
            httpStatus: 410,
          });
        }

        const fiveMinuteAgo = new Date();
        fiveMinuteAgo.setMinutes(fiveMinuteAgo.getMinutes() - 5);
        if (gist.status != "ready") {
          if (gist.model.statusDate < fiveMinuteAgo) {
            await gist.updateIfNeeded({ force: true });
          }
          if (gist.status == "error") {
            throw new AnonymousError(
              gist.model.statusMessage
                ? gist.model.statusMessage
                : "gist_not_available",
              {
                object: gist,
                httpStatus: 500,
              }
            );
          }
          throw new AnonymousError("gist_not_ready", {
            httpStatus: 425,
            object: gist,
          });
        }

        await gist.updateIfNeeded();
      }

      res.json({
        url: redirectURL,
        lastUpdateDate: gist.model.statusDate,
        isAdmin: user?.isAdmin === true,
        isOwner: user?.id == gist.model.owner,
      });
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

router.get(
  "/:gistId/content",
  async (req: express.Request, res: express.Response) => {
    const gist = await getGist(req, res);
    if (!gist) return;
    try {
      await gist.countView();
      res.header("Cache-Control", "no-cache");
      res.json(gist.content());
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

export default router;
