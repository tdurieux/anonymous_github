import { Octokit } from "@octokit/rest";
import got from "got";
import { Readable } from "stream";
import { OctokitResponse } from "@octokit/types";

import config from "../../config";
import storage from "../storage";
import Repository from "../Repository";
import GitHubBase from "./GitHubBase";
import AnonymizedFile from "../AnonymizedFile";
import { RepositoryStatus, SourceBase } from "../types";
import AnonymousError from "../AnonymousError";

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
      if (progress && that.repository.status) {
        await that.repository.updateStatus(
          that.repository.status,
          progress.transferred.toString()
        );
      }
      if (inDownload) {
        progressTimeout = setTimeout(updateProgress, 1500);
      }
    }
    updateProgress();

    try {
      const downloadStream = got.stream(response.url);
      downloadStream.addListener("downloadProgress", (p) => (progress = p));
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

    await this.repository.updateStatus(RepositoryStatus.READY);
  }

  async getFileContent(file: AnonymizedFile): Promise<Readable> {
    if (await storage.exists(file.originalCachePath)) {
      return storage.read(file.originalCachePath);
    }
    await this.download();
    // update the file list
    await this.repository.files({ force: true });
    return storage.read(file.originalCachePath);
  }

  async getFiles() {
    const folder = this.repository.originalCachePath;
    if (!(await storage.exists(folder))) {
      await this.download();
    }
    return storage.listFiles(folder);
  }
}
