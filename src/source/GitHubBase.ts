import { Octokit } from "@octokit/rest";
import { trace } from "@opentelemetry/api";
import { Readable } from "stream";

import AnonymizedFile from "../AnonymizedFile";
import { Branch, Tree } from "../types";
import { GitHubRepository } from "./GitHubRepository";
import config from "../../config";
import UserModel from "../database/users/users.model";

export default abstract class GitHubBase {
  abstract type: "GitHubDownload" | "GitHubStream" | "Zip";
  githubRepository: GitHubRepository;
  branch: Branch;
  accessToken: string | undefined;
  validToken: boolean = false;

  constructor(data: {
    accessToken?: string;
    commit?: string;
    branch?: string;
    repositoryId?: string;
    repositoryName?: string;
  }) {
    this.accessToken = data.accessToken;
    const branches = [];
    if (data.branch && data.commit) {
      branches.push({ commit: data.commit, name: data.branch });
    }
    this.githubRepository = new GitHubRepository({
      name: data.repositoryName,
      externalId: data.repositoryId,
      branches,
    });
    this.branch = branches[0];
  }

  abstract getFileContent(
    file: AnonymizedFile,
    progress?: (status: string) => void
  ): Promise<Readable>;

  abstract getFiles(progress?: (status: string) => void): Promise<Tree>;

  static octokit(token: string) {
    return new Octokit({
      auth: token,
      request: {
        fetch: fetch,
      },
    });
  }

  static async checkToken(token: string) {
    const octokit = GitHubBase.octokit(token);
    try {
      await octokit.users.getAuthenticated();
      return true;
    } catch (error) {
      return false;
    }
  }

  async getToken(ownerID?: any) {
    const span = trace.getTracer("ano-file").startSpan("GHBase.getToken");
    span.setAttribute("repoId", this.githubRepository.fullName || "");
    try {
      if (this.validToken) {
        return this.accessToken as string;
      }
      if (ownerID) {
        const user = await UserModel.findById(ownerID, {
          accessTokens: 1,
        });
        if (user?.accessTokens.github) {
          const check = await GitHubBase.checkToken(user.accessTokens.github);
          if (check) {
            this.accessToken = user.accessTokens.github;
            this.validToken = true;
            return this.accessToken;
          }
        }
      }
      if (this.accessToken) {
        if (await GitHubBase.checkToken(this.accessToken)) {
          this.validToken = true;
          return this.accessToken;
        }
      }
      this.accessToken = config.GITHUB_TOKEN;
      return this.accessToken;
    } finally {
      span.end();
    }
  }

  get url() {
    return "https://github.com/" + this.githubRepository.fullName;
  }

  toJSON(): any {
    return {
      type: this.type,
      fullName: this.githubRepository.fullName?.toString(),
      branch: this.branch?.name,
      commit: this.branch?.commit,
    };
  }
}
