import { promisify } from "util";
import * as stream from "stream";
import * as express from "express";
import GitHubStream from "../core/source/GitHubStream";
import {
  anonymizePath,
  AnonymizeTransformer,
  isTextFile,
} from "../core/anonymize-utils";
import { handleError } from "../server/routes/route-utils";
import { lookup } from "mime-types";
import GitHubDownload from "../core/source/GitHubDownload";
import got from "got";
import { Parse } from "unzip-stream";
import archiver = require("archiver");

export const router = express.Router();

router.post(
  "/download",
  async (req: express.Request, res: express.Response) => {
    const token: string = req.body.token;
    const repoFullName = req.body.repoFullName.split("/");
    const repoId = req.body.repoId;
    const branch = req.body.branch;
    const commit = req.body.commit;
    const anonymizerOptions = req.body.anonymizerOptions;

    try {
      const source = new GitHubDownload({
        repoId,
        organization: repoFullName[0],
        repoName: repoFullName[1],
        commit: commit,
        getToken: () => token,
      });
      const response = await source.getZipUrl();
      const downloadStream = got.stream(response.url);

      res.on("error", (error) => {
        console.error(error);
        downloadStream.destroy();
      });

      res.on("close", () => {
        downloadStream.destroy();
      });

      const archive = archiver("zip", {});
      downloadStream
        .on("error", (error) => {
          console.error(error);
          try {
            archive.finalize();
          } catch (error) {}
        })
        .on("close", () => {
          try {
            archive.finalize();
          } catch (error) {}
        })
        .pipe(Parse())
        .on("entry", (entry) => {
          if (entry.type === "File") {
            try {
              const fileName = anonymizePath(
                entry.path.substring(entry.path.indexOf("/") + 1),
                anonymizerOptions.terms || []
              );
              const anonymizer = new AnonymizeTransformer(anonymizerOptions);
              anonymizer.opt.filePath = fileName;
              const st = entry.pipe(anonymizer);
              archive.append(st, { name: fileName });
            } catch (error) {
              entry.autodrain();
              console.error(error);
            }
          } else {
            entry.autodrain();
          }
        })
        .on("error", (error) => {
          console.error(error);
          try {
            archive.finalize();
          } catch (error) {}
        })
        .on("finish", () => {
          try {
            archive.finalize();
          } catch (error) {}
        });
      archive.pipe(res).on("error", (error) => {
        console.error(error);
        res.end();
      });
    } catch (error) {
      handleError(error, res);
    }
  }
);
router.post("/", async (req: express.Request, res: express.Response) => {
  req.body = req.body || {};
  const token: string = req.body.token;
  const repoFullName = req.body.repoFullName.split("/");
  const repoId = req.body.repoId;
  const branch = req.body.branch;
  const fileSha = req.body.sha;
  const commit = req.body.commit;
  const filePath = req.body.filePath;
  const anonymizerOptions = req.body.anonymizerOptions;
  const anonymizer = new AnonymizeTransformer(anonymizerOptions);

  const source = new GitHubStream({
    repoId,
    organization: repoFullName[0],
    repoName: repoFullName[1],
    commit: commit,
    getToken: () => token,
  });
  try {
    const content = await source.getFileContentCache(
      filePath,
      repoId,
      () => fileSha
    );
    const mime = lookup(filePath);
    if (mime && !filePath.endsWith(".ts")) {
      res.contentType(mime);
    } else if (isTextFile(filePath)) {
      res.contentType("text/plain");
    }
    res.header("Accept-Ranges", "none");
    anonymizer.once("transform", (data) => {
      if (!mime && data.isText) {
        res.contentType("text/plain");
      } else if (!mime && !data.isText) {
        res.contentType("application/octet-stream");
      }
    });
    function handleStreamError(error: Error) {
      if (!content.closed && !content.destroyed) {
        content.destroy();
      }
      handleError(error, res);
    }
    content
      .on("error", handleStreamError)
      .pipe(anonymizer)
      .pipe(res)
      .on("error", handleStreamError)
      .on("close", () => {
        if (!content.closed && !content.destroyed) {
          content.destroy();
        }
      });
  } catch (error) {
    handleError(error, res);
  }
});

export default router;
