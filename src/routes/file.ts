import * as express from "express";
import AnonymizedFile from "../AnonymizedFile";
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
    
      const f = new AnonymizedFile(repo, {
        anonymizedPath,
      });
      if (!(await f.isFileSupported())) {
        return res.status(500).send({ error: "file_not_supported" });
      }
      res.attachment(
        anonymizedPath.substring(anonymizedPath.lastIndexOf("/") + 1)
      );
      await f.send(res);
    } catch (error) {
      return handleError(error, res);
    }
  }
);

export default router;
