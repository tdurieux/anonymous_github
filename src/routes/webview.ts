import * as express from "express";
import { getRepo, handleError } from "./route-utils";
import * as path from "path";
import AnonymizedFile from "../AnonymizedFile";
import GitHubDownload from "../source/GitHubDownload";
import AnonymousError from "../AnonymousError";
import { Tree, TreeElement } from "../types";
import * as marked from "marked";
import { streamToString } from "../anonymize-utils";

const router = express.Router();

const indexPriority = [
  "index.html",
  "index.htm",
  "index.md",
  "index.txt",
  "index.org",
  "index.1st",
  "index",
  "readme.md",
  "readme.txt",
  "readme.org",
  "readme.1st",
  "readme",
];

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
    let f = new AnonymizedFile({
      repository: repo,
      anonymizedPath: requestPath,
    });
    if (requestPath[requestPath.length - 1] == "/") {
      // find index file
      const paths = f.anonymizedPath.trim().split("/");

      let currentAnonymized: TreeElement = await repo.anonymizedFiles({
        includeSha: true,
      });
      for (let i = 0; i < paths.length; i++) {
        const fileName = paths[i];
        if (fileName == "") {
          continue;
        }
        if (!(currentAnonymized as Tree)[fileName]) {
          throw new AnonymousError("file_not_found", {
            object: repo,
            httpStatus: 404,
          });
        }
        currentAnonymized = (currentAnonymized as Tree)[fileName];
      }

      let best_match = null;
      indexSelector: for (const p of indexPriority) {
        for (let filename in currentAnonymized) {
          if (filename.toLowerCase() == p) {
            best_match = filename;
            break indexSelector;
          }
        }
      }
      if (best_match) {
        requestPath = path.join(requestPath, best_match);
        f = new AnonymizedFile({
          repository: repo,
          anonymizedPath: requestPath,
        });
      }
    }

    if (!f.isFileSupported()) {
      throw new AnonymousError("file_not_supported", {
        httpStatus: 400,
        object: f,
      });
    }
    if (f.extension() == "md") {
      const content = await streamToString(await f.anonymizedContent());
      res
        .contentType("html")
        .send(marked.marked(content, { headerIds: false, mangle: false }));
    } else {
      f.send(res);
    }
  } catch (error) {
    handleError(error, res, req);
  }
}

router.get("/:repoId/*", webView);
router.get("/:repoId", (req: express.Request, res: express.Response) => {
  res.redirect("/w" + req.url + "/");
});

export default router;
