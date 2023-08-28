import { Octokit } from "@octokit/rest";
import got from "got";
import { Readable } from "stream";
import { OctokitResponse } from "@octokit/types";

import config from "../../config";
import storage from "../storage";
import Repository from "../Repository";
import GitHubBase from "./GitHubBase";
import AnonymizedFile from "../AnonymizedFile";
import { FILE_TYPE, RepositoryStatus, SourceBase } from "../types";
import AnonymousError from "../AnonymousError";
import { tryCatch } from "bullmq";

export default class GitHubDownload extends GitHubBase implements SourceBase {
  constructor(
    data: {
      type: "GitHubDownload" | "GitHubStream" | "Zip";
      branch?: string;
      commit?: string;
      repositoryId?: string;
      repositoryName?: string;
      accessToken?: string;
    },
    repository: Repository
  ) {
    super(data, repository);
  }

  private async _getZipUrl(
    auth?: string
  ): Promise<OctokitResponse<unknown, 302>> {
    const octokit = new Octokit({ auth });
    return octokit.rest.repos.downloadZipballArchive({
      owner: this.githubRepository.owner,
      repo: this.githubRepository.repo,
      ref: this.branch?.commit || "HEAD",
      method: "HEAD",
    });
  }

  async download(token?: string) {
    const fiveMinuteAgo = new Date();
    fiveMinuteAgo.setMinutes(fiveMinuteAgo.getMinutes() - 5);
    if (
      this.repository.status == "download" &&
      this.repository.model.statusDate > fiveMinuteAgo
    )
      throw new AnonymousError("repo_in_download", {
        httpStatus: 404,
        object: this.repository,
      });
    let response: OctokitResponse<unknown, number>;
    try {
      if (!token) {
        token = await this.getToken();
      }
      response = await this._getZipUrl(token);
    } catch (error) {
      if ((error as any).status == 401 && config.GITHUB_TOKEN) {
        try {
          response = await this._getZipUrl(config.GITHUB_TOKEN);
        } catch (error) {
          await this.repository.resetSate(
            RepositoryStatus.ERROR,
            "repo_not_accessible"
          );
          throw new AnonymousError("repo_not_accessible", {
            httpStatus: 404,
            cause: error as Error,
            object: this.repository,
          });
        }
      } else {
        await this.repository.resetSate(
          RepositoryStatus.ERROR,
          "repo_not_accessible"
        );
        throw new AnonymousError("repo_not_accessible", {
          httpStatus: 404,
          object: this.repository,
          cause: error as Error,
        });
      }
    }
    await this.repository.updateStatus(RepositoryStatus.DOWNLOAD);
    const originalPath = this.repository.originalCachePath;
    await storage.mk(originalPath);
    let progress: { transferred: number } | undefined = undefined;
    let progressTimeout;
    let inDownload = true;

    const that = this;
    async function updateProgress() {
      if (inDownload) {
        if (progress && that.repository.status == RepositoryStatus.DOWNLOAD) {
          await that.repository.updateStatus(
            that.repository.status,
            progress.transferred.toString()
          );
        }
        progressTimeout = setTimeout(updateProgress, 1500);
      }
    }
    updateProgress();

    try {
      const downloadStream = got.stream(response.url);
      downloadStream.addListener("downloadProgress", async (p) => {
        progress = p;
      });
      await storage.extractZip(originalPath, downloadStream, undefined, this);
    } catch (error) {
      await this.repository.updateStatus(
        RepositoryStatus.ERROR,
        "unable_to_download"
      );
      throw new AnonymousError("unable_to_download", {
        httpStatus: 500,
        cause: error as Error,
        object: this.repository,
      });
    } finally {
      inDownload = false;
      clearTimeout(progressTimeout);
    }

    this.repository.model.isReseted = false;
    try {
      await this.repository.updateStatus(RepositoryStatus.READY);
    } catch (error) {
      console.error(error);
    }
  }

  async getFileContent(file: AnonymizedFile): Promise<Readable> {
    const exists = await storage.exists(file.originalCachePath);
    if (exists === FILE_TYPE.FILE) {
      return storage.read(file.originalCachePath);
    } else if (exists === FILE_TYPE.FOLDER) {
      throw new AnonymousError("folder_not_supported", {
        httpStatus: 400,
        object: file,
      });
    }
    // will throw an error if the file is not in the repository
    await file.originalPath();

    // the cache is not ready, we need to download the repository
    await this.download();
    return storage.read(file.originalCachePath);
  }

  async getFiles() {
    const folder = this.repository.originalCachePath;
    if ((await storage.exists(folder)) === FILE_TYPE.NOT_FOUND) {
      await this.download();
    }
    return storage.listFiles(folder);
  }
}
