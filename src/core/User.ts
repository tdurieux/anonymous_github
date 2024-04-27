import { trace } from "@opentelemetry/api";

import AnonymizedRepositoryModel from "./model/anonymizedRepositories/anonymizedRepositories.model";
import RepositoryModel from "./model/repositories/repositories.model";
import { IUserDocument } from "./model/users/users.types";
import Repository from "./Repository";
import { GitHubRepository } from "./source/GitHubRepository";
import PullRequest from "./PullRequest";
import AnonymizedPullRequestModel from "./model/anonymizedPullRequests/anonymizedPullRequests.model";
import { octokit } from "./GitHubUtils";

/**
 * Model for a user
 */
export default class User {
  private _model: IUserDocument;
  constructor(model: IUserDocument) {
    this._model = model;
  }

  get id(): string {
    return this._model.id;
  }

  get username(): string {
    return this._model.username;
  }

  get isAdmin(): boolean {
    return !!this._model.isAdmin;
  }

  get accessToken(): string {
    return this._model.accessTokens.github;
  }

  get photo(): string | undefined {
    return this._model.photo;
  }

  get default() {
    return this._model.default;
  }

  set default(d) {
    this._model.default = d;
  }

  /**
   * Get the GitHub repositories of the user
   * @param opt options
   * @returns the list of github repositories
   */
  async getGitHubRepositories(opt?: {
    /**
     * Get the repository from GitHub
     */
    force: boolean;
  }): Promise<GitHubRepository[]> {
    const span = trace
      .getTracer("ano-file")
      .startSpan("User.getGitHubRepositories");
    span.setAttribute("username", this.username);
    if (
      !this._model.repositories ||
      this._model.repositories.length == 0 ||
      opt?.force === true
    ) {
      // get the list of repo from github
      const oct = octokit(this.accessToken);
      const repositories = (
        await oct.paginate("GET /user/repos", {
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

      // find the repositories that are already in the database
      const finds = (
        await RepositoryModel.find({
          externalId: {
            $in: repositories.map((repo) => repo.externalId),
          },
        }).select("externalId")
      ).map((m) => m.externalId);

      // save all the new repositories
      await Promise.all(
        repositories
          .filter((r) => finds.indexOf(r.externalId) == -1)
          .map((r) => r.save())
      );

      // save only the if of the repositories in the user model
      this._model.repositories = (
        await RepositoryModel.find({
          externalId: {
            $in: repositories.map((repo) => repo.externalId),
          },
        }).select("id")
      ).map((m) => m.id);

      // have the model
      await this._model.save();
      span.end();
      return repositories.map((r) => new GitHubRepository(r));
    } else {
      const out = (
        await RepositoryModel.find({ _id: { $in: this._model.repositories } })
      ).map((i) => new GitHubRepository(i));
      span.end();
      return out;
    }
  }

  /**
   * Get the lost of anonymized repositories
   * @returns the list of anonymized repositories
   */
  async getRepositories() {
    const span = trace.getTracer("ano-file").startSpan("User.getRepositories");
    span.setAttribute("username", this.username);
    const repositories = (
      await AnonymizedRepositoryModel.find({
        owner: this.id,
      }).exec()
    ).map((d) => new Repository(d));
    const promises = [];
    for (let repo of repositories) {
      if (
        repo.status == "ready" &&
        repo.options.expirationMode != "never" &&
        repo.options.expirationDate != null &&
        repo.options.expirationDate < new Date()
      ) {
        // expire the repository
        promises.push(repo.expire());
      }
    }
    await Promise.all(promises);
    span.end();
    return repositories;
  }
  /**
   * Get the lost of anonymized repositories
   * @returns the list of anonymized repositories
   */
  async getPullRequests() {
    const span = trace.getTracer("ano-file").startSpan("User.getPullRequests");
    span.setAttribute("username", this.username);
    const pullRequests = (
      await AnonymizedPullRequestModel.find({
        owner: this.id,
      }).exec()
    ).map((d) => new PullRequest(d));
    const promises = [];
    for (let repo of pullRequests) {
      if (
        repo.status == "ready" &&
        repo.options.expirationMode != "never" &&
        repo.options.expirationDate != null &&
        repo.options.expirationDate < new Date()
      ) {
        // expire the repository
        promises.push(repo.expire());
      }
    }
    await Promise.all(promises);
    span.end();
    return pullRequests;
  }

  get model() {
    return this._model;
  }

  toJSON() {
    return this._model.toJSON();
  }
}
