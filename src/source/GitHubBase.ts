import AnonymizedFile from "../AnonymizedFile";
import { Branch, Tree } from "../types";
import { GitHubRepository } from "./GitHubRepository";
import config from "../../config";
import Repository from "../Repository";
import { Readable } from "stream";
import UserModel from "../database/users/users.model";
import AnonymousError from "../AnonymousError";

export default abstract class GitHubBase {
  type: "GitHubDownload" | "GitHubStream" | "Zip";
  githubRepository: GitHubRepository;
  branch: Branch;
  accessToken: string | undefined;
  repository: Repository;

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

  async getToken() {
    const user = await UserModel.findById(this.repository.owner.id);
    if (user && user.accessTokens.github) {
      return user.accessTokens.github as string;
    }
    if (this.accessToken) {
      try {
        // const app = new OAuthApp({
        //   clientType: "github-app",
        //   clientId: config.CLIENT_ID,
        //   clientSecret: config.CLIENT_SECRET,
        // });
        // await app.checkToken({
        //   token: this.accessToken,
        // });
        return this.accessToken;
      } catch (error) {
        console.debug("[ERROR] Token is invalid", this.repository.repoId);
        this.accessToken = config.GITHUB_TOKEN;
      }
    }
    return config.GITHUB_TOKEN;
  }

  get url() {
    return "https://github.com/" + this.githubRepository.fullName;
  }

  toJSON(): any {
    return {
      type: this.type,
      fullName: this.githubRepository.fullName?.toString(),
      branch: this.branch.name,
      commit: this.branch.commit,
    };
  }
}
