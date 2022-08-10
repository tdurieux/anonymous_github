import * as express from "express";
import { getRepo, handleError } from "./route-utils";
import * as path from "path";
import AnonymizedFile from "../AnonymizedFile";
import GitHubDownload from "../source/GitHubDownload";
import AnonymousError from "../AnonymousError";

const router = express.Router();

async function webView(req: express.Request, res: express.Response) {
  const repo = await getRepo(req, res);
  if (!repo) return;
  try {
    if (!repo.options.page || !repo.options.pageSource) {
      throw new AnonymousError("page_not_activated", {
        httpStatus: 400,
        object: repo,
      });
    }

    if (
      repo.options.pageSource?.branch !=
      (repo.source as GitHubDownload).branch.name
    ) {
      throw new AnonymousError("page_not_supported_on_different_branch", {
        httpStatus: 400,
        object: repo,
      });
    }

    let requestPath = path.join(
      repo.options.pageSource?.path,
      req.path.substring(
        req.path.indexOf(req.params.repoId) + req.params.repoId.length
      )
    );
    if (requestPath[requestPath.length - 1] == "/") {
      requestPath = path.join(requestPath, "index.html");
    }
    requestPath = requestPath;
    const f = new AnonymizedFile({
      repository: repo,
      anonymizedPath: requestPath,
    });
    if (!(await f.isFileSupported())) {
      throw new AnonymousError("file_not_supported", {
        httpStatus: 400,
        object: f,
      });
    }
    f.send(res);
  } catch (error) {
    handleError(error, res, req);
  }
}

router.get("/:repoId/*", webView);
router.get("/:repoId", (req: express.Request, res: express.Response) => {
  res.redirect("/w" + req.url + "/");
});

export default router;
