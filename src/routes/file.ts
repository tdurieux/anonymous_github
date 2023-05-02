import * as express from "express";
import AnonymizedFile from "../AnonymizedFile";
import AnonymousError from "../AnonymousError";
import { getRepo, handleError } from "./route-utils";

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
      includeFiles: false,
    });
    if (!repo) return;

    try {
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
      // cache the file for 5min
      res.header("Cache-Control", "max-age=300");
      await Promise.all([repo.countView(), f.send(res)]);
    } catch (error) {
      return handleError(error, res, req);
    }
  }
);

export default router;
