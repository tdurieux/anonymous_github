import AnonymizedFile from "../AnonymizedFile";
import { Branch, Tree } from "../types";
import { GitHubRepository } from "./GitHubRepository";
import config from "../../config";
import Repository from "../Repository";
import { Readable } from "stream";
import UserModel from "../database/users/users.model";
import AnonymousError from "../AnonymousError";
import { Octokit } from "@octokit/rest";
import { trace } from "@opentelemetry/api";

export default abstract class GitHubBase {
  type: "GitHubDownload" | "GitHubStream" | "Zip";
  githubRepository: GitHubRepository;
  branch: Branch;
  accessToken: string | undefined;
  repository: Repository;
  validToken: boolean = false;

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
    this.type = data.type;
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
    this.repository = repository;
    this.branch = branches[0];
  }

  async getFileContent(file: AnonymizedFile): Promise<Readable> {
    throw new AnonymousError("method_not_implemented", {
      httpStatus: 501,
      object: this,
    });
  }

  getFiles(): Promise<Tree> {
    throw new AnonymousError("method_not_implemented", {
      httpStatus: 501,
      object: this,
    });
  }

  static async checkToken(token: string) {
    const octokit = new Octokit({ auth: token });
    try {
      await octokit.users.getAuthenticated();
      return true;
    } catch (error) {
      return false;
    }
  }

  async getToken() {
    const span = trace.getTracer("ano-file").startSpan("GHBase.getToken");
    span.setAttribute("repoId", this.repository.repoId);
    try {
      if (this.validToken) {
        return this.accessToken as string;
      }
      const user = await UserModel.findById(this.repository.owner.id, {
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
