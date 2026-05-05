import * as express from "express";
import GitHubStream from "../core/source/GitHubStream";
import {
  AnonymizeTransformer,
  isTextFile,
} from "../core/anonymize-utils";
import { handleError } from "../server/routes/route-utils";
import { lookup } from "mime-types";
import { streamAnonymizedZip } from "../core/zipStream";

export const router = express.Router();

router.post(
  "/download",
  async (req: express.Request, res: express.Response) => {
    const token: string = req.body.token;
    const repoFullName = req.body.repoFullName.split("/");
    const repoId = req.body.repoId;
    const commit = req.body.commit;
    const anonymizerOptions = req.body.anonymizerOptions;
    const contentOptions = req.body.contentOptions;

    try {
      await streamAnonymizedZip(
        {
          repoId,
          organization: repoFullName[0],
          repoName: repoFullName[1],
          commit,
          getToken: () => token,
          anonymizerOptions,
          contentOptions,
        },
        res
      );
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
  const fileSha = req.body.sha;
  const fileSize: number | undefined =
    typeof req.body.size === "number" ? req.body.size : undefined;
  const commit = req.body.commit;
  const filePath: string = req.body.filePath;
  const anonymizerOptions = req.body.anonymizerOptions;
  const anonymizer = new AnonymizeTransformer(anonymizerOptions);

  // Defence in depth: the parent server validates filePath against
  // FileModel before calling us, but the streamer joins this directly
  // into the storage path on disk. Reject any segment that could escape
  // the repo root, in case the streamer is ever exposed beyond the
  // internal network or a buggy caller forwards an unvalidated path.
  if (
    typeof filePath !== "string" ||
    filePath.length === 0 ||
    filePath
      .split(/[\\/]/)
      .some((segment) => segment === ".." || segment === "")
  ) {
    return res.status(400).json({ error: "invalid_file_path" });
  }

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
      () => ({ sha: fileSha, size: fileSize })
    );
    const mime = lookup(filePath);
    if (mime && !filePath.endsWith(".ts")) {
      res.contentType(mime);
    } else if (isTextFile(filePath)) {
      res.contentType("text/plain");
    }
    // Only declare Accept-Ranges: none for text files — they get rewritten on
    // the fly so byte ranges aren't meaningful. For binary entries the
    // transformer is a passthrough; let <video>/<audio> fall back to a full
    // download instead of refusing to play (#538).
    if (isTextFile(filePath)) {
      res.header("Accept-Ranges", "none");
    }
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
