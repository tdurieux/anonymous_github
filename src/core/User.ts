import config from "../config";
import { GitHubRepositoryInfo, APP_PROVIDER, appRepositories, appUserToken } from "./github-app";
import CredentialModel from "./model/credentials/credentials.model";
import { getCredentialToken } from "./credentials";
import AnonymizedRepositoryModel from "./model/anonymizedRepositories/anonymizedRepositories.model";
import RepositoryModel from "./model/repositories/repositories.model";
import UserModel from "./model/users/users.model";
import { IUserDocument } from "./model/users/users.types";
import Repository from "./Repository";
import { GitHubRepository } from "./source/GitHubRepository";
import PullRequest from "./PullRequest";
import AnonymizedPullRequestModel from "./model/anonymizedPullRequests/anonymizedPullRequests.model";
import Gist from "./Gist";
import AnonymizedGistModel from "./model/anonymizedGists/anonymizedGists.model";
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

  async getAccessToken(): Promise<string> {
    const oauth = await getCredentialToken(this.id);
    if (oauth || !config.GITHUB_APP_ENABLED) return oauth;
    return appUserToken(this.id);
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
    if (config.GITHUB_APP_ENABLED && await CredentialModel.exists({ ownerId: this.id, provider: APP_PROVIDER })) {
      const oauth = await getCredentialToken(this.id);
      let appRepos: GitHubRepositoryInfo[] = [];
      try { appRepos = await appRepositories(this.id); }
      catch (error) { if (!oauth) throw error; }
      // Discovery may list the independently connected OAuth provider when the
      // App is unavailable. Resource access never falls back between providers.
      const legacy = oauth ? await octokit(oauth).paginate("GET /user/repos", { visibility: "all", per_page: 100 }) : [];
      const repos = new Map<number, GitHubRepositoryInfo>(legacy.map(r => [r.id, r]));
      for (const r of appRepos) repos.set(r.id, r);
      return [...repos.values()].map(r => new GitHubRepository(new RepositoryModel({ externalId: "gh_" + r.id,
        name: r.full_name, url: r.html_url, size: r.size, defaultBranch: r.default_branch })));
    }
    if (
      !this._model.repositories ||
      this._model.repositories.length == 0 ||
      opt?.force === true
    ) {
      // get the list of repo from github
      const oct = octokit(await this.getAccessToken());
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

      // find the repositories that are already in the database — fetch both
      // externalId and id so we can both detect duplicates and reuse the
      // ids of existing rows without re-querying.
      const externalIds = repositories.map((repo) => repo.externalId);
      const existing = await RepositoryModel.find({
        externalId: { $in: externalIds },
      }).select("id externalId");
      const existingByExternalId = new Map(
        existing.map((m) => [m.externalId, m.id])
      );

      // save all the new repositories
      const newRepos = repositories.filter(
        (r) => !existingByExternalId.has(r.externalId)
      );
      const saved = await Promise.all(newRepos.map((r) => r.save()));
      for (const m of saved) {
        existingByExternalId.set(m.externalId, m.id);
      }

      // collect ids in the order of the upstream repositories list
      this._model.repositories = externalIds
        .map((eid) => existingByExternalId.get(eid))
        .filter((id) => !!id) as unknown as typeof this._model.repositories;

      // have the model
      await UserModel.updateOne(
        { _id: this._model._id },
        { $set: { repositories: this._model.repositories } }
      ).exec();
      return repositories.map((r) => new GitHubRepository(r));
    } else {
      // Only the fields read by GitHubRepository.toJSON() (and the immediate
      // callers in user routes). Branches/readme are loaded on demand by
      // GitHubRepository methods, which issue their own queries.
      const out = (
        await RepositoryModel.find({
          _id: { $in: this._model.repositories },
        }).select(
          "externalId name url size hasPage pageSource defaultBranch"
        )
      ).map((i) => new GitHubRepository(i));
      return out;
    }
  }

  /**
   * Get the lost of anonymized repositories
   * @returns the list of anonymized repositories
   */
  async getRepositories() {
    const memberships: Record<string, unknown>[] = [{ owner: this.id }];
    const githubId = this.model.externalIDs?.github;
    if (githubId) memberships.push({ "coauthors.githubId": githubId });
    if (this.username) {
      memberships.push({ coauthors: { $elemMatch: {
        username: this.username,
        $or: [{ githubId: { $exists: false } }, { githubId: null }, { githubId: "" }],
      } } });
    }
    const query = { $or: memberships };
    const repositories = (
      await AnonymizedRepositoryModel.find(query).exec()
    ).map((d) => new Repository(d));
    const promises = [];
    for (const repo of repositories) {
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
    return repositories;
  }
  /**
   * Get the lost of anonymized repositories
   * @returns the list of anonymized repositories
   */
  async getPullRequests() {
    const pullRequests = (
      await AnonymizedPullRequestModel.find({
        owner: this.id,
      }).exec()
    ).map((d) => new PullRequest(d));
    const promises = [];
    for (const repo of pullRequests) {
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
    return pullRequests;
  }

  /**
   * Get the list of anonymized gists
   */
  async getGists() {
    const gists = (
      await AnonymizedGistModel.find({ owner: this.id }).exec()
    ).map((d) => new Gist(d));
    const promises = [];
    for (const g of gists) {
      if (
        g.status == "ready" &&
        g.options.expirationMode != "never" &&
        g.options.expirationDate != null &&
        g.options.expirationDate < new Date()
      ) {
        promises.push(g.expire());
      }
    }
    await Promise.all(promises);
    return gists;
  }

  get model() {
    return this._model;
  }

  toJSON() {
    const value = this._model.toJSON();
    delete (value as Partial<typeof value>).accessTokens;
    delete value.apiTokens;
    return value;
  }
}
