import * as express from "express";
import AnonymizedFile from "../../core/AnonymizedFile";
import AnonymousError from "../../core/AnonymousError";
import { getRepo, handleError } from "./route-utils";
import { fileETag } from "./file-etag";

export const router = express.Router();

router.get(
  "/:repoId/file/:path*",
  async (req: express.Request, res: express.Response) => {
    const anonymizedPath = decodeURI(
      new URL(req.url, `${req.protocol}://${req.hostname}`).pathname.replace(
        `/${req.params.repoId}/file/`,
        ""
      )
    );
    if (anonymizedPath.endsWith("/")) {
      return handleError(
        new AnonymousError("folder_not_supported", {
          httpStatus: 404,
          object: anonymizedPath,
        }),
        res
      );
    }

    const repo = await getRepo(req, res, {
      nocheck: false,
    });
    if (!repo) return;

    try {
      if (!(await repo.isReady())) {
        throw new AnonymousError("repository_not_ready", {
          object: repo,
          httpStatus: 503,
        });
      }
      const f = new AnonymizedFile({
        repository: repo,
        anonymizedPath,
      });
      if (!f.isFileSupported()) {
        throw new AnonymousError("file_not_supported", {
          httpStatus: 403,
          object: f,
        });
      }
      if (req.query.download) {
        res.attachment(
          anonymizedPath.substring(anonymizedPath.lastIndexOf("/") + 1)
        );
      }
      const etag = fileETag(
        req.query.v as string | undefined,
        repo.model.options
      );
      res.header("ETag", etag);
      // Force the browser to revalidate every time. The previous 210-day
      // max-age was keyed only on the upstream sha, so editing the
      // anonymization term list left old anonymizations cached under the
      // same URL.
      res.header("Cache-Control", "private, no-cache, must-revalidate");
      if (req.headers["if-none-match"] === etag) {
        return res.status(304).end();
      }
      await f.send(res);
      await repo.countView();
    } catch (error) {
      return handleError(error, res, req);
    }
  }
);

export default router;
