import got from "got";
import { Parse } from "unzip-stream";
import archiver = require("archiver");

import GitHubDownload from "./source/GitHubDownload";
import { AnonymizeTransformer, anonymizePath } from "./anonymize-utils";

export interface StreamAnonymizedZipOptions {
  repoId: string;
  organization: string;
  repoName: string;
  commit: string;
  getToken: () => string | Promise<string>;
  anonymizerOptions: ConstructorParameters<typeof AnonymizeTransformer>[0];
}

/**
 * Stream the GitHub source zip for a repository, anonymize each entry on the
 * fly, and pipe the resulting archive into the provided writable response.
 *
 * No data is written to local storage — the zip flows GitHub → unzip → per
 * file anonymizer → archiver → response.
 */
export async function streamAnonymizedZip(
  opt: StreamAnonymizedZipOptions,
  res: NodeJS.WritableStream & {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
  }
): Promise<void> {
  const source = new GitHubDownload({
    repoId: opt.repoId,
    organization: opt.organization,
    repoName: opt.repoName,
    commit: opt.commit,
    getToken: opt.getToken,
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
      } catch {
        /* ignored */
      }
    })
    .on("close", () => {
      try {
        archive.finalize();
      } catch {
        /* ignored */
      }
    })
    .pipe(Parse())
    .on("entry", (entry: NodeJS.ReadableStream & { type: string; path: string; autodrain: () => void }) => {
      if (entry.type === "File") {
        try {
          const fileName = anonymizePath(
            entry.path.substring(entry.path.indexOf("/") + 1),
            opt.anonymizerOptions.terms || []
          );
          // Pass filePath via the constructor — AnonymizeTransformer reads it
          // there to decide whether the entry is text (and therefore should be
          // anonymized) vs binary (passthrough). Assigning afterwards leaves
          // isText=false for every file, so the zip ships unanonymized.
          const anonymizer = new AnonymizeTransformer({
            ...opt.anonymizerOptions,
            filePath: fileName,
          });
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
    .on("error", (error: Error) => {
      console.error(error);
      try {
        archive.finalize();
      } catch {
        /* ignored */
      }
    })
    .on("finish", () => {
      try {
        archive.finalize();
      } catch {
        /* ignored */
      }
    });

  archive.pipe(res).on("error", (error) => {
    console.error(error);
    (res as { end?: () => void }).end?.();
  });
}
