import * as express from "express";
import GitHubStream from "../core/source/GitHubStream";
import { AnonymizeTransformer, isTextFile } from "../core/anonymize-utils";
import { handleError } from "../server/routes/route-utils";
import { lookup } from "mime-types";

export const router = express.Router();

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
  console.log(`[FILE] ${repoId}/${filePath}`);
  const content = await source.getFileContentCache(
    filePath,
    repoId,
    () => fileSha
  );
  try {
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
