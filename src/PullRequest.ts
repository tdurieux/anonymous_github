import { RepositoryStatus, Source, Tree, TreeElement, TreeFile } from "./types";
import User from "./User";
import { anonymizeContent, anonymizePath } from "./anonymize-utils";
import UserModel from "./database/users/users.model";
import Conference from "./Conference";
import ConferenceModel from "./database/conference/conferences.model";
import AnonymousError from "./AnonymousError";
import { IAnonymizedPullRequestDocument } from "./database/anonymizedPullRequests/anonymizedPullRequests.types";
import config from "../config";
import { Octokit } from "@octokit/rest";
import got from "got";

export default class PullRequest {
  private _model: IAnonymizedPullRequestDocument;
  owner: User;

  constructor(data: IAnonymizedPullRequestDocument) {
    this._model = data;
    this.owner = new User(new UserModel({ _id: data.owner }));
  }

  getToken() {
    if (this.owner && this.owner.accessToken) {
      return this.owner.accessToken;
    }
    if (this._model.source.accessToken) {
      try {
        return this._model.source.accessToken;
      } catch (error) {
        console.debug("[ERROR] Token is invalid", this.pullRequestId);
      }
    }
    return config.GITHUB_TOKEN;
  }

  async download() {
    console.debug("[INFO] Downloading pull request", this.pullRequestId);
    const auth = this.getToken();
    const octokit = new Octokit({ auth });
    const [owner, repo] = this._model.source.repositoryFullName.split("/");
    const pull_number = this._model.source.pullRequestId;
    const prInfo = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number,
    });

    prInfo.data.updated_at;
    prInfo.data.draft;
    prInfo.data.merged;
    prInfo.data.merged_at;
    prInfo.data.state;
    prInfo.data.base.repo.full_name;
    prInfo.data.head.repo.full_name;
    const comments = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: pull_number,
      per_page: 100,
    });
    // const commits = await octokit.rest.pulls.listCommits({
    //   owner,
    //   repo,
    //   pull_number,
    //   per_page: 100,
    // });
    // const files = await octokit.rest.pulls.listFiles({
    //   owner,
    //   repo,
    //   pull_number,
    //   per_page: 100,
    // });
    const diff = await got(prInfo.data.diff_url);
    this._model.pullRequest = {
      diff: diff.body,
      title: prInfo.data.title,
      body: prInfo.data.body,
      creationDate: new Date(prInfo.data.created_at),
      updatedDate: new Date(prInfo.data.updated_at),
      draft: prInfo.data.draft,
      merged: prInfo.data.merged,
      mergedDate: prInfo.data.merged_at
        ? new Date(prInfo.data.merged_at)
        : null,
      state: prInfo.data.state,
      baseRepositoryFullName: prInfo.data.base.repo.full_name,
      headRepositoryFullName: prInfo.data.head.repo.full_name,
      comments: comments.data.map((comment) => ({
        body: comment.body,
        creationDate: new Date(comment.created_at),
        updatedDate: new Date(comment.updated_at),
        author: comment.user.login,
      })),
    };
  }

  /**
   * Check the status of the pullRequest
   */
  check() {
    if (
      this._model.options.expirationMode !== "never" &&
      this.status == "ready"
    ) {
      if (this._model.options.expirationDate <= new Date()) {
        this.expire();
      }
    }
    if (
      this.status == "expired" ||
      this.status == "expiring" ||
      this.status == "removing" ||
      this.status == "removed"
    ) {
      throw new AnonymousError("pullRequest_expired", {
        object: this,
        httpStatus: 410,
      });
    }
    const fiveMinuteAgo = new Date();
    fiveMinuteAgo.setMinutes(fiveMinuteAgo.getMinutes() - 5);

    if (
      this.status == "preparing" ||
      (this.status == "download" && this._model.statusDate > fiveMinuteAgo)
    ) {
      throw new AnonymousError("pullRequest_not_ready", {
        object: this,
      });
    }
  }

  /**
   * Update the pullRequest if a new commit exists
   *
   * @returns void
   */
  async updateIfNeeded(opt?: { force: boolean }): Promise<void> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (
      opt?.force ||
      (this._model.options.update && this._model.lastView < yesterday)
    ) {
      await this.download();
      this._model.lastView = new Date();
      await this._model.save();
    }
  }
  /**
   * Download the require state for the pullRequest to work
   *
   * @returns void
   */
  async anonymize() {
    if (this.status == "ready") return;
    await this.updateStatus("preparing");
    await this.updateIfNeeded({ force: true });
    return this.updateStatus("ready");
  }

  /**
   * Update the last view and view count
   */
  async countView() {
    this._model.lastView = new Date();
    this._model.pageView = (this._model.pageView || 0) + 1;
    return this._model.save();
  }

  /**
   * Update the status of the pullRequest
   * @param status the new status
   * @param errorMessage a potential error message to display
   */
  async updateStatus(status: RepositoryStatus, statusMessage?: string) {
    this._model.status = status;
    this._model.statusDate = new Date();
    this._model.statusMessage = statusMessage;
    return this._model.save();
  }

  /**
   * Expire the pullRequest
   */
  async expire() {
    await this.updateStatus("expiring");
    await this.resetSate();
    await this.updateStatus("expired");
  }

  /**
   * Remove the pullRequest
   */
  async remove() {
    await this.updateStatus("removing");
    await this.resetSate();
    await this.updateStatus("removed");
  }

  /**
   * Reset/delete the state of the pullRequest
   */
  async resetSate(status?: RepositoryStatus, statusMessage?: string) {
    if (status) this._model.status = status;
    if (statusMessage) this._model.statusMessage = statusMessage;
    // remove cache
    this._model.pullRequest = null;
    return Promise.all([this._model.save()]);
  }

  /**
   * Returns the conference of the pullRequest
   *
   * @returns conference of the pullRequest
   */
  async conference(): Promise<Conference | null> {
    if (!this._model.conference) {
      return null;
    }
    const conference = await ConferenceModel.findOne({
      conferenceID: this._model.conference,
    });
    if (conference) return new Conference(conference);
    return null;
  }

  /***** Getters ********/

  get pullRequestId() {
    return this._model.pullRequestId;
  }

  get options() {
    return this._model.options;
  }

  get source() {
    return this._model.source;
  }

  get model() {
    return this._model;
  }

  get status() {
    return this._model.status;
  }

  content() {
    const output: any = {
      anonymizeDate: this._model.anonymizeDate,
      merged: this._model.pullRequest.merged,
      mergedDate: this._model.pullRequest.mergedDate,
      state: this._model.pullRequest.state,
      draft: this._model.pullRequest.draft,
    };
    if (this.options.title) {
      output.title = anonymizeContent(this._model.pullRequest.title, this);
    }
    if (this.options.body) {
      output.body = anonymizeContent(this._model.pullRequest.body, this);
    }
    if (this.options.comments) {
      output.comments = this._model.pullRequest.comments.map((comment) => {
        const o: any = {};
        if (this.options.body) o.body = anonymizeContent(comment.body, this);
        if (this.options.username)
          o.author = anonymizeContent(comment.author, this);
        if (this.options.date) {
          o.updatedDate = comment.updatedDate;
          o.creationDate = comment.creationDate;
        }
        return o;
      });
    }
    if (this.options.diff) {
      output.diff = anonymizeContent(this._model.pullRequest.diff, this);
    }
    if (this.options.origin) {
      output.baseRepositoryFullName =
        this._model.pullRequest.baseRepositoryFullName;
    }
    if (this.options.date) {
      output.updatedDate = this.model.pullRequest.updatedDate;
      output.creationDate = this.model.pullRequest.creationDate;
    }
    return output;
  }

  toJSON() {
    return {
      pullRequestId: this._model.pullRequestId,
      options: this._model.options,
      conference: this._model.conference,
      anonymizeDate: this._model.anonymizeDate,
      status: this._model.status,
      state: this.model.pullRequest.state,
      merged: this.model.pullRequest.merged,
      mergedDate: this.model.pullRequest.mergedDate,
      statusMessage: this._model.statusMessage,
      source: {
        pullRequestId: this._model.source.pullRequestId,
        repositoryFullName: this._model.source.repositoryFullName,
      },
      pullRequest: this._model.pullRequest,
      lastView: this._model.lastView,
      pageView: this._model.pageView,
    };
  }
}
