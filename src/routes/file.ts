import * as express from "express";
import AnonymizedFile from "../AnonymizedFile";
import AnonymousError from "../AnonymousError";
import { getRepo, handleError } from "./route-utils";

export const router = express.Router();

router.get(
  "/:repoId/file/:path*",
  async (req: express.Request, res: express.Response) => {
    let anonymizedPath = req.params.path;
    if (req.params[0]) {
      anonymizedPath += req.params[0];
    }
    anonymizedPath = anonymizedPath;

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
