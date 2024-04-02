import got from "got";
import { Readable } from "stream";
import { OctokitResponse } from "@octokit/types";

import storage from "../storage";
import GitHubBase from "./GitHubBase";
import AnonymizedFile from "../AnonymizedFile";
import { SourceBase } from "../types";
import AnonymousError from "../AnonymousError";
import { trace } from "@opentelemetry/api";
import { FILE_TYPE } from "../storage/Storage";

export default class GitHubDownload extends GitHubBase implements SourceBase {
  type: "GitHubDownload" | "GitHubStream" | "Zip" = "GitHubDownload";
  constructor(
    data: {
      branch?: string;
      commit?: string;
      repositoryId?: string;
      repositoryName?: string;
      accessToken?: string;
    },
    readonly repoId: string
  ) {
    super(data);
  }

  private async _getZipUrl(
    auth: string
  ): Promise<OctokitResponse<unknown, 302>> {
    const octokit = GitHubBase.octokit(auth as string);
    return octokit.rest.repos.downloadZipballArchive({
      owner: this.githubRepository.owner,
      repo: this.githubRepository.repo,
      ref: this.branch?.commit || "HEAD",
      method: "HEAD",
    });
  }

  async download(token: string, progress?: (status: string) => void) {
    const span = trace.getTracer("ano-file").startSpan("GHDownload.download");
    span.setAttribute("repoId", this.githubRepository.fullName || "");
    try {
      let response: OctokitResponse<unknown, number>;
      try {
        response = await this._getZipUrl(token);
      } catch (error) {
        span.recordException(error as Error);
        throw new AnonymousError("repo_not_accessible", {
          httpStatus: 404,
          object: this.githubRepository,
          cause: error as Error,
        });
      }
      await storage.mk(this.repoId);
      let downloadProgress: { transferred: number } | undefined = undefined;
      let progressTimeout;
      let inDownload = true;

      async function updateProgress() {
        if (inDownload) {
          if (progress) {
            progress(downloadProgress?.transferred?.toString() || "");
          }
          progressTimeout = setTimeout(updateProgress, 1500);
        }
      }
      updateProgress();

      try {
        const downloadStream = got.stream(response.url);
        downloadStream.addListener("downloadProgress", async (p) => {
          downloadProgress = p;
        });
        await storage.extractZip(
          this.repoId,
          "",
          downloadStream,
          undefined,
          this
        );
      } catch (error) {
        span.recordException(error as Error);
        throw new AnonymousError("unable_to_download", {
          httpStatus: 500,
          cause: error as Error,
          object: this.githubRepository,
        });
      } finally {
        inDownload = false;
        clearTimeout(progressTimeout);
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
    span.setAttribute("repoId", this.githubRepository.fullName || "");
    try {
      const exists = await storage.exists(file.filePath);
      if (exists === FILE_TYPE.FILE) {
        return storage.read(this.repoId, file.filePath);
      } else if (exists === FILE_TYPE.FOLDER) {
        throw new AnonymousError("folder_not_supported", {
          httpStatus: 400,
          object: file,
        });
      }
      // will throw an error if the file is not in the repository
      await file.originalPath();

      // the cache is not ready, we need to download the repository
      await this.download(
        await this.getToken(file.repository.owner.id),
        progress
      );
      return storage.read(this.repoId, file.filePath);
    } finally {
      span.end();
    }
  }

  async getFiles() {
    if ((await storage.exists(this.repoId)) === FILE_TYPE.NOT_FOUND) {
      await this.download(await this.getToken());
    }
    return storage.listFiles(this.repoId);
  }
}
