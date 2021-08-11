import { Octokit } from "@octokit/rest";
import AnonymizedRepositoryModel from "./database/anonymizedRepositories/anonymizedRepositories.model";
import RepositoryModel from "./database/repositories/repositories.model";
import { IUserDocument } from "./database/users/users.types";
import Repository from "./Repository";
import { GitHubRepository } from "./source/GitHubRepository";

export default class User {
  private _model: IUserDocument;
  constructor(model: IUserDocument) {
    this._model = model;
  }

  get username(): string {
    return this._model.username;
  }

  get accessToken(): string {
    return this._model.accessToken;
  }

  get photo(): string {
    return this._model.photo;
  }

  get default() {
    return this._model.default;
  }

  set default(d) {
    this._model.default = d;
  }

  async getGitHubRepositories(opt?: {
    force: boolean;
  }): Promise<GitHubRepository[]> {
    if (!this._model.repositories || opt?.force === true) {
      // get the list of repo from github
      const octokit = new Octokit({ auth: this.accessToken });
      const repositories = (
        await octokit.paginate(octokit.repos.listForAuthenticatedUser, {
          visibility: "all",
          sort: "pushed",
          per_page: 100,
        })
      ).map((r) => {
        return new RepositoryModel({
          externalId: "gh_" + r.id,
          name: r.full_name,
          url: r.html_url,
          size: r.size,
          defaultBranch: r.default_branch,
        });
      });

      const finds = (
        await RepositoryModel.find({
          externalId: {
            $in: repositories.map((repo) => repo.externalId),
          },
        }).select("externalId")
      ).map((m) => m.externalId);

      await Promise.all(
        repositories
          .filter((r) => finds.indexOf(r.externalId) == -1)
          .map((r) => r.save())
      );

      this._model.repositories = (
        await RepositoryModel.find({
          externalId: {
            $in: repositories.map((repo) => repo.externalId),
          },
        }).select("id")
      ).map((m) => m.id);
      await this._model.save();
      return repositories.map((r) => new GitHubRepository(r));
    } else {
      return (
        await RepositoryModel.find({ _id: { $in: this._model.repositories } })
      ).map((i) => new GitHubRepository(i));
    }
  }

  async getRepositories() {
    const repositories = (
      await AnonymizedRepositoryModel.find({
        owner: this.username,
      }).exec()
    ).map((d) => new Repository(d));
    for (let repo of repositories) {
      if (repo.options.expirationDate) {
        repo.options.expirationDate = new Date(repo.options.expirationDate);
      }
      if (
        repo.options.expirationMode != "never" &&
        repo.options.expirationDate != null &&
        repo.options.expirationDate < new Date()
      ) {
        await repo.expire()
      }
    }
    return repositories;
  }

  toJSON() {
    return this._model.toJSON();
  }
}
