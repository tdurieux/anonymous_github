import AnonymizedFile from "../AnonymizedFile";
import { Branch, Tree } from "../types";
import { GitHubRepository } from "./GitHubRepository";
import config from "../../config";
import { OAuthApp } from "@octokit/oauth-app";
import Repository from "../Repository";
import * as stream from "stream";
import UserModel from "../database/users/users.model";
import AnonymousError from "../AnonymousError";

export default abstract class GitHubBase {
  type: "GitHubDownload" | "GitHubStream" | "Zip";
  githubRepository: GitHubRepository;
  branch: Branch;
  accessToken: string;
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
    this.githubRepository = new GitHubRepository({
      name: data.repositoryName,
      externalId: data.repositoryId,
      branches: [{ commit: data.commit, name: data.branch }],
    });
    this.repository = repository;
    this.branch = { commit: data.commit, name: data.branch };
  }

  async getFileContent(file: AnonymizedFile): Promise<stream.Readable> {
    throw new AnonymousError("Method not implemented.");
  }
  
  getFiles(): Promise<Tree> {
    throw new AnonymousError("Method not implemented.");
  }

  async getToken(owner?: string) {
    if (owner) {
      const user = await UserModel.findOne({ username: owner });
      if (user && user.accessTokens.github) {
        return user.accessTokens.github as string;
      }
    }
    if (this.accessToken) {
      try {
        const app = new OAuthApp({
          clientType: "github-app",
          clientId: config.CLIENT_ID,
          clientSecret: config.CLIENT_SECRET,
        });
        await app.checkToken({
          token: this.accessToken,
        });
        return this.accessToken;
      } catch (error) {
        // console.debug("Token is invalid.", error);
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
