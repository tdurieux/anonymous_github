import got from "got";
import { Readable } from "stream";
import { OctokitResponse } from "@octokit/types";

import storage from "../storage";
import GitHubBase, { GitHubBaseData } from "./GitHubBase";
import { FILE_TYPE } from "../storage/Storage";
import { octokit } from "../GitHubUtils";
import AnonymousError from "../AnonymousError";
import AnonymizedFile from "../AnonymizedFile";

export default class GitHubDownload extends GitHubBase {
  type: "GitHubDownload" | "GitHubStream" | "Zip" = "GitHubDownload";
  constructor(data: GitHubBaseData) {
    super(data);
  }

  public async getZipUrl(): Promise<OctokitResponse<unknown, 302>> {
    const oct = octokit(await this.data.getToken());
    return oct.rest.repos.downloadZipballArchive({
      owner: this.data.organization,
      repo: this.data.repoName,
      ref: this.data.commit || "HEAD",
      method: "HEAD",
    });
  }

  async download(progress?: (status: string) => void) {
    let response: OctokitResponse<unknown, number>;
    try {
      response = await this.getZipUrl();
    } catch (error) {
      throw new AnonymousError("repo_not_found", {
        httpStatus: (error as { status?: number }).status || 404,
        object: this.data,
        cause: error as Error,
      });
    }
    // Wipe any partial state from a previous failed extraction. Without
    // this, half-extracted trees would survive and later be served as the
    // canonical listing.
    await storage.rm(this.data.repoId);
    await storage.mk(this.data.repoId);
    try {
      const downloadStream = got.stream(response.url);
      downloadStream.addListener(
        "downloadProgress",
        (p: { transferred?: number }) => {
          if (progress && p.transferred) {
            progress("Repository download: " + humanFileSize(p.transferred));
          }
        }
      );
      await storage.extractZip(
        this.data.repoId,
        "",
        downloadStream,
        this.type
      );
      // Write the completion marker last. Its presence — and only its
      // presence — means "the cache for this repo is fully extracted and
      // safe to serve." Any code path that finds files but no marker must
      // treat the cache as incomplete and re-download.
      await storage.write(this.data.repoId, COMPLETE_MARKER, "ok", this.type);
    } catch (error) {
      // Best-effort cleanup of the partial extraction so the next call
      // doesn't trip over half-written files.
      await storage.rm(this.data.repoId).catch(() => undefined);
      throw new AnonymousError("unable_to_download", {
        httpStatus: 500,
        cause: error as Error,
        object: this.data,
      });
    }
  }

  private async isCacheComplete(): Promise<boolean> {
    return (
      (await storage.exists(this.data.repoId, COMPLETE_MARKER)) ===
      FILE_TYPE.FILE
    );
  }

  async getFileContent(
    file: AnonymizedFile,
    progress?: (status: string) => void
  ): Promise<Readable> {
    if (!(await this.isCacheComplete())) {
      // will throw an error if the file is not in the repository
      await file.originalPath();
      await this.download(progress);
      return storage.read(this.data.repoId, file.filePath);
    }
    const exists = await storage.exists(this.data.repoId, file.filePath);
    if (exists === FILE_TYPE.FILE) {
      // Validate the cached file size against the upstream tree size when
      // it's known — guards against the same poisoned-cache class as in
      // GitHubStream. cached.size >= expected is accepted (equal for
      // normal files, larger for LFS-resolved blobs).
      let expectedSize: number | undefined;
      try {
        expectedSize = await file.size();
      } catch {
        // not all callers populate a FileModel; fall back to reading
      }
      if (expectedSize != null && expectedSize > 0) {
        try {
          const stat = await storage.fileInfo(this.data.repoId, file.filePath);
          if (stat.size != null && stat.size < expectedSize) {
            await storage.rm(this.data.repoId, file.filePath);
            await file.originalPath();
            await this.download(progress);
            return storage.read(this.data.repoId, file.filePath);
          }
        } catch {
          // fall through to read; if read fails the caller surfaces the error
        }
      }
      return storage.read(this.data.repoId, file.filePath);
    } else if (exists === FILE_TYPE.FOLDER) {
      throw new AnonymousError("folder_not_supported", {
        httpStatus: 400,
        object: file,
      });
    }
    // marker present but file missing — shouldn't happen, but redownload
    // rather than 404 on a stale partial cache.
    await file.originalPath();
    await this.download(progress);
    return storage.read(this.data.repoId, file.filePath);
  }

  async getFiles(progress?: (status: string) => void) {
    if (!(await this.isCacheComplete())) {
      await this.download(progress);
    }
    let nbFiles = 0;
    const all = await storage.listFiles(this.data.repoId, "", {
      onEntry: () => {
        if (progress) {
          nbFiles++;
          progress("List file: " + nbFiles);
        }
      },
    });
    return all.filter((f) => f.name !== COMPLETE_MARKER);
  }
}

// Sentinel object/file written at the root of an extracted repo cache
// once the extraction has finished successfully. Its presence means the
// cache is complete. Hidden so it doesn't show up in user listings.
const COMPLETE_MARKER = ".anon-complete";

function humanFileSize(bytes: number, si = false, dp = 1) {
  const thresh = si ? 1000 : 1024;

  if (Math.abs(bytes) < thresh) {
    return bytes + "B";
  }

  const units = si
    ? ["kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"]
    : ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"];
  let u = -1;
  const r = 10 ** dp;

  do {
    bytes /= thresh;
    ++u;
  } while (
    Math.round(Math.abs(bytes) * r) / r >= thresh &&
    u < units.length - 1
  );

  return bytes.toFixed(dp) + "" + units[u];
}
