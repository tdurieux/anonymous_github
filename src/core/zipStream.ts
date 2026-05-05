import got from "got";
import { Parse } from "unzip-stream";
import archiver = require("archiver");

import GitHubDownload from "./source/GitHubDownload";
import {
  AnonymizeTransformer,
  anonymizePathCompiled,
  compileTerms,
} from "./anonymize-utils";

export interface StreamAnonymizedZipOptions {
  repoId: string;
  organization: string;
  repoName: string;
  commit: string;
  getToken: () => string | Promise<string>;
  anonymizerOptions: ConstructorParameters<typeof AnonymizeTransformer>[0];
  /**
   * Per-repo content gates. Matches Repository.options — `image: true`
   * includes images, `pdf: true` includes PDFs. The single-file `/file/...`
   * endpoint enforces these via AnonymizedFile.isFileSupported; without
   * the same gate here, the ZIP shipped a superset of what the per-file
   * API exposes, which is privacy-relevant when a maintainer toggles
   * image=false to suppress identifying screenshots.
   */
  contentOptions?: {
    image?: boolean;
    pdf?: boolean;
  };
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "ico",
  "bmp",
  "tiff",
  "tif",
  "webp",
  "avif",
  "heif",
  "heic",
]);

function isEntryAllowed(
  filename: string,
  contentOptions?: { image?: boolean; pdf?: boolean }
): boolean {
  if (!contentOptions) return true;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (contentOptions.pdf === false && ext === "pdf") return false;
  if (contentOptions.image === false && IMAGE_EXTENSIONS.has(ext)) return false;
  return true;
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
  const compiledTerms = compileTerms(opt.anonymizerOptions.terms || []);

  // Track whether the upstream zipball finished cleanly. If it didn't,
  // we must NOT finalize the archive — finalizing while bytes are still
  // flowing to the response produces a valid-looking ZIP that's missing
  // entries, which the client has no way to detect (status 200, archive
  // opens). Destroy the response instead so the client sees a connection
  // drop and knows the download failed. Same class of silent-truncation
  // bug as #694.
  let upstreamSucceeded = false;
  const fail = (error: Error) => {
    console.error(error);
    archive.abort();
    const destroyable = res as unknown as {
      destroy?: (err?: Error) => void;
      end?: () => void;
    };
    if (typeof destroyable.destroy === "function") {
      destroyable.destroy(error);
    } else if (typeof destroyable.end === "function") {
      destroyable.end();
    }
  };

  downloadStream
    .on("error", fail)
    .pipe(Parse())
    .on("entry", (entry: NodeJS.ReadableStream & { type: string; path: string; autodrain: () => void }) => {
      if (entry.type === "File") {
        try {
          const fileName = anonymizePathCompiled(
            entry.path.substring(entry.path.indexOf("/") + 1),
            compiledTerms
          );
          if (!isEntryAllowed(fileName, opt.contentOptions)) {
            entry.autodrain();
            return;
          }
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
    .on("error", fail)
    .on("finish", () => {
      upstreamSucceeded = true;
      try {
        archive.finalize();
      } catch {
        /* ignored */
      }
    });

  archive.pipe(res).on("error", (error) => {
    console.error(error);
    if (!upstreamSucceeded) {
      // archive errored while we were still depending on upstream bytes:
      // treat as failure rather than truncating.
      fail(error);
      return;
    }
    (res as { end?: () => void }).end?.();
  });
}
