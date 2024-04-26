import * as express from "express";
import { getRepo, handleError } from "./route-utils";
import * as path from "path";
import AnonymizedFile from "../../core/AnonymizedFile";
import AnonymousError from "../../core/AnonymousError";
import * as marked from "marked";
import { streamToString } from "../../core/anonymize-utils";

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

    if (repo.options.pageSource.branch != repo.model.source.branch) {
      throw new AnonymousError("page_not_supported_on_different_branch", {
        httpStatus: 400,
        object: repo,
      });
    }

    let wRoot = repo.options.pageSource.path;
    if (wRoot.at(0) == "/") {
      wRoot = wRoot.substring(1);
    }
    const filePath = req.path.split(req.params.repoId)[1];
    let requestPath = path.join(wRoot, filePath);

    let f = new AnonymizedFile({
      repository: repo,
      anonymizedPath: requestPath,
    });
    if (
      requestPath.at(-1) == "/" &&
      req.headers.accept?.includes("text/html")
    ) {
      // look for index file
      const candidates = await repo.files({
        recursive: false,
        path: await f.originalPath(),
      });

      let bestMatch = null;
      indexSelector: for (const p of indexPriority) {
        for (const file of candidates) {
          if (file.name.toLowerCase() == p) {
            bestMatch = file;
            break indexSelector;
          }
        }
      }
      if (bestMatch) {
        requestPath = path.join(bestMatch.path, bestMatch.name);
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
        .contentType("text/html")
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
