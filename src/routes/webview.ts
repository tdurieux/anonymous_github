import * as express from "express";
import { getRepo, handleError } from "./route-utils";
import * as path from "path";
import AnonymizedFile from "../AnonymizedFile";
import GitHubDownload from "../source/GitHubDownload";

const router = express.Router();

async function webView(req: express.Request, res: express.Response) {
  const repo = await getRepo(req, res);
  if (!repo) return;
  try {
    if (!repo.options.page) {
      throw "page_not_activated";
    }
    if (!repo.options.pageSource) {
      throw "page_not_activated";
    }

    if (
      repo.options.pageSource?.branch !=
      (repo.source as GitHubDownload).branch.name
    ) {
      throw "page_not_supported_on_different_branch";
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
    const f = new AnonymizedFile(repo, {
      anonymizedPath: requestPath,
    });
    if (!(await f.isFileSupported())) {
      return res.status(500).send({ error: "file_not_supported" });
    }
    f.send(res);
  } catch (error) {
    handleError(error, res);
  }
}

router.get("/:repoId/*", webView);
router.get("/:repoId", (req: express.Request, res: express.Response) => {
  res.redirect("/w" + req.url + "/");
});

export default router;
