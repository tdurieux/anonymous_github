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

    const repo = await getRepo(req, res);
    if (!repo) return;

    try {
      await repo.countView();
    
      const f = new AnonymizedFile({
        repository: repo,
        anonymizedPath,
      });
      if (!(await f.isFileSupported())) {
        throw new AnonymousError("file_not_supported", {
          httpStatus: 403,
          object: f,
        });
      }
      res.attachment(
        anonymizedPath.substring(anonymizedPath.lastIndexOf("/") + 1)
      );
      // ache the file for 6 hours
      res.header('Cache-Control', 'max-age=21600000');
      await f.send(res);
    } catch (error) {
      return handleError(error, res);
    }
  }
);

export default router;
