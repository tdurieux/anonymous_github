import got from "got";
import { Readable } from "stream";
import { OctokitResponse } from "@octokit/types";

import storage from "../storage";
import GitHubBase, { GitHubBaseData } from "./GitHubBase";
import { trace } from "@opentelemetry/api";
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
    const span = trace.getTracer("ano-file").startSpan("GHDownload.download");
    span.setAttribute("repoId", this.data.repoId);
    try {
      let response: OctokitResponse<unknown, number>;
      try {
        response = await this.getZipUrl();
      } catch (error) {
        span.recordException(error as Error);
        throw new AnonymousError("repo_not_found", {
          httpStatus: (error as any).status || 404,
          object: this.data,
          cause: error as Error,
        });
      }
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
      } catch (error) {
        span.recordException(error as Error);
        throw new AnonymousError("unable_to_download", {
          httpStatus: 500,
          cause: error as Error,
          object: this.data,
        });
      }
    } finally {
      span.end();
    }
  }

  async getFileContent(
    file: AnonymizedFile,
    progress?: (status: string) => void
  ): Promise<Readable> {
    const span = trace
      .getTracer("ano-file")
      .startSpan("GHDownload.getFileContent");
    span.setAttribute("repoId", this.data.repoId);
    try {
      const exists = await storage.exists(this.data.repoId, file.filePath);
      if (exists === FILE_TYPE.FILE) {
        return storage.read(this.data.repoId, file.filePath);
      } else if (exists === FILE_TYPE.FOLDER) {
        throw new AnonymousError("folder_not_supported", {
          httpStatus: 400,
          object: file,
        });
      }
      // will throw an error if the file is not in the repository
      await file.originalPath();

      // the cache is not ready, we need to download the repository
      await this.download(progress);
      return storage.read(this.data.repoId, file.filePath);
    } finally {
      span.end();
    }
  }

  async getFiles(progress?: (status: string) => void) {
    if ((await storage.exists(this.data.repoId)) === FILE_TYPE.NOT_FOUND) {
      await this.download(progress);
    }
    let nbFiles = 0;
    return storage.listFiles(this.data.repoId, "", {
      onEntry: () => {
        if (progress) {
          nbFiles++;
          progress("List file: " + nbFiles);
        }
      },
    });
  }
}

function humanFileSize(bytes: number, si = false, dp = 1) {
  const thresh = si ? 1000 : 1024;

  bytes = bytes / 8;

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
