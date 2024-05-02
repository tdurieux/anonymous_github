import * as express from "express";
import { getRepo, handleError } from "./route-utils";
import * as path from "path";
import AnonymizedFile from "../../core/AnonymizedFile";
import AnonymousError from "../../core/AnonymousError";
import * as marked from "marked";
import { streamToString } from "../../core/anonymize-utils";
import { IFile } from "../../core/model/files/files.types";

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

    const wRoot = repo.options.pageSource.path;

    const indexRepoId = req.path.indexOf(req.params.repoId);
    const filePath = req.path.substring(
      indexRepoId + req.params.repoId.length + 1
    );
    let requestPath = path.join(wRoot, filePath);
    if (requestPath.at(0) == "/" || requestPath.at(0) == ".") {
      requestPath = requestPath.substring(1);
    }

    let f = new AnonymizedFile({
      repository: repo,
      anonymizedPath: requestPath,
    });
    let info: IFile | null = null;
    try {
      info = await f.getFileInfo();
    } catch (error) {}
    if (
      req.headers.accept?.includes("text/html") &&
      (filePath == "" || (info && info.size == null))
    ) {
      const folderPath = info
        ? path.join(info.path, info.name)
        : wRoot.substring(1);
      // look for index file
      const candidates = await repo.files({
        recursive: false,
        // look for file at the root of the page source
        path: folderPath == "." ? "" : folderPath,
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
      } else {
        // print list of files in the root repository
        const body = `<div class="container p-3"><h2>Content of ${filePath}</h2><div class="list-group">${candidates
          .map(
            (c) =>
              `<a class="list-group-item list-group-item-action" href="${
                c.name + (c.size == null ? "/" : "")
              }">${c.name + (c.size == null ? "/" : "")}</a>`
          )
          .join("")}</div></div>`;
        const html = `<!DOCTYPE html><html><head><title>Content</title></head><link rel="stylesheet" href="/css/all.min.css" /><body>${body}</body></html>`;
        return res.contentType("text/html").send(html);
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
      const body = marked.marked(content, { headerIds: false, mangle: false });
      const html = `<!DOCTYPE html><html><head><title>Content</title></head><link rel="stylesheet" href="/css/all.min.css" /><body><div class="container p-3 file-content markdown-body">${body}<div></body></html>`;
      res.contentType("text/html").send(html);
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
