import storage from "./storage";
import { RepositoryStatus } from "./types";
import { Readable } from "stream";
import * as sha1 from "crypto-js/sha1";
import User from "./User";
import GitHubStream from "./source/GitHubStream";
import GitHubDownload from "./source/GitHubDownload";
import Zip from "./source/Zip";
import { anonymizePath } from "./anonymize-utils";
import UserModel from "./model/users/users.model";
import { IAnonymizedRepositoryDocument } from "./model/anonymizedRepositories/anonymizedRepositories.types";
import { AnonymizeTransformer } from "./anonymize-utils";
import GitHubBase from "./source/GitHubBase";
import Conference from "./Conference";
import ConferenceModel from "./model/conference/conferences.model";
import AnonymousError from "./AnonymousError";
import { downloadQueue } from "../queue";
import { isConnected } from "../server/database";
import {
  getRepositoryFromGitHub,
  GitHubRepository,
} from "./source/GitHubRepository";
import { trace } from "@opentelemetry/api";
import { getToken } from "./GitHubUtils";
import { FILE_TYPE } from "./storage/Storage";
import config from "../config";
import FileModel from "./model/files/files.model";
import { IFile } from "./model/files/files.types";
import AnonymizedFile from "./AnonymizedFile";
import { FilterQuery } from "mongoose";
function anonymizeTreeRecursive(
  tree: IFile[],
  terms: string[],
  opt: {
    /** Include the file sha in the response */
    includeSha: boolean;
  } = {
    includeSha: false,
  }
): Partial<IFile>[] {
  return tree.map((file) => {
    return {
      name: anonymizePath(file.name, terms),
      path: anonymizePath(file.path, terms),
      size: file.size,
      sha: opt.includeSha
        ? file.sha
        : file.size
        ? sha1(file.sha || "")
            .toString()
            .substring(0, 8)
        : undefined,
    };
  });
}

export default class Repository {
  private _model: IAnonymizedRepositoryDocument;
  owner: User;

  constructor(data: IAnonymizedRepositoryDocument) {
    this._model = data;
    this.owner = new User(new UserModel({ _id: data.owner }));
    this.owner = new User(new UserModel({ _id: data.owner }));
    this.owner.model.isNew = false;
  }

  private checkedToken: boolean = false;

  async getToken() {
    if (this.checkedToken) return this._model.source.accessToken as string;
    const originalToken = this._model.source.accessToken;
    const token = await getToken(this);
    if (originalToken != token) {
      this._model.source.accessToken = token;
      if (isConnected) {
        await this._model.save();
      }
    }
    this.checkedToken = true;
    return token;
  }

  get source() {
    const ghRepo = new GitHubRepository({
      name: this.model.source.repositoryName,
    });
    switch (this.model.source.type) {
      case "GitHubDownload":
        return new GitHubDownload({
          repoId: this.repoId,
          commit: this.model.source.commit || "HEAD",
          organization: ghRepo.owner,
          repoName: ghRepo.repo,
          getToken: () => this.getToken(),
        });
      case "GitHubStream":
        return new GitHubStream({
          repoId: this.repoId,
          commit: this.model.source.commit || "HEAD",
          organization: ghRepo.owner,
          repoName: ghRepo.repo,
          getToken: () => this.getToken(),
        });
      case "Zip":
        return new Zip(this.model.source, this.repoId);
      default:
        throw new AnonymousError("unsupported_source", {
          object: this,
          httpStatus: 400,
        });
    }
  }

  /**
   * Get the anonymized file tree
   * @param opt force to get an updated list of files
   * @returns The anonymized file tree
   */
  async anonymizedFiles(
    opt: {
      /** Force to refresh the file tree */
      force?: boolean;
      /** Include the file sha in the response */
      includeSha: boolean;
      recursive?: boolean;
      path?: string;
    } = {
      force: false,
      includeSha: false,
      recursive: true,
    }
  ): Promise<Partial<IFile>[]> {
    const terms = this._model.options.terms || [];
    return anonymizeTreeRecursive(await this.files(opt), terms, opt);
  }

  /**
   * Get the file tree
   *
   * @param opt force to get an updated list of files
   * @returns The file tree
   */
  async files(
    opt: {
      recursive?: boolean;
      path?: string;
      force?: boolean;
      progress?: (status: string) => void;
    } = {
      recursive: true,
      force: false,
    }
  ): Promise<IFile[]> {
    const span = trace.getTracer("ano-file").startSpan("Repository.files");
    span.setAttribute("repoId", this.repoId);
    try {
      const hasFile = await FileModel.exists({ repoId: this.repoId }).exec();
      if (!hasFile || opt.force) {
        await FileModel.deleteMany({ repoId: this.repoId }).exec();
        const files = await this.source.getFiles(opt.progress);
        files.forEach((f) => (f.repoId = this.repoId));
        await FileModel.insertMany(files);

        this._model.size = { storage: 0, file: 0 };
        await this.computeSize();
      }
      if (opt.path?.includes(config.ANONYMIZATION_MASK)) {
        const f = new AnonymizedFile({
          repository: this,
          anonymizedPath: opt.path,
        });
        opt.path = await f.originalPath();
      }

      let pathQuery: string | RegExp | undefined = opt.path
        ? new RegExp(`^${opt.path}`)
        : undefined;
      if (opt.recursive === false) {
        pathQuery = opt.path ? new RegExp(`^${opt.path}$`) : "";
      }

      const query: FilterQuery<IFile> = {
        repoId: this.repoId,
      };
      if (pathQuery !== undefined) {
        query.path = pathQuery;
      }
      return await FileModel.find(query).exec();
    } finally {
      span.end();
    }
  }

  /**
   * Check the status of the repository
   */
  check() {
    if (
      this._model.options.expirationMode !== "never" &&
      this.status == RepositoryStatus.READY &&
      this._model.options.expirationDate
    ) {
      if (this._model.options.expirationDate <= new Date()) {
        this._model.status = RepositoryStatus.EXPIRED;
        this.expire();
      }
    }
    if (
      this.status == RepositoryStatus.EXPIRED ||
      this.status == RepositoryStatus.EXPIRING ||
      this.status == RepositoryStatus.REMOVING ||
      this.status == RepositoryStatus.REMOVED
    ) {
      throw new AnonymousError("repository_expired", {
        object: this,
        httpStatus: 410,
      });
    }
    const fiveMinuteAgo = new Date();
    fiveMinuteAgo.setMinutes(fiveMinuteAgo.getMinutes() - 5);

    if (
      this.status == RepositoryStatus.PREPARING ||
      (this.status == RepositoryStatus.DOWNLOAD &&
        this._model.statusDate > fiveMinuteAgo)
    ) {
      throw new AnonymousError("repository_not_ready", {
        object: this,
      });
    }
  }

  /**
   * Compress and anonymize the repository
   *
   * @returns A stream of anonymized repository compressed
   */
  zip(): Promise<Readable> {
    return storage.archive(this.repoId, "", {
      format: "zip",
      fileTransformer: (filename: string) =>
        this.generateAnonymizeTransformer(filename),
    });
  }

  generateAnonymizeTransformer(filePath: string) {
    return new AnonymizeTransformer({
      filePath: filePath,
      terms: this.options.terms,
      image: this.options.image,
      link: this.options.link,
      repoId: this.repoId,
      repoName: this.model.source.repositoryName,
      branchName: this.model.source.branch || "main",
    });
  }

  async isReady() {
    if (this.status !== RepositoryStatus.READY) return false;
    if (
      (this.source.type == "GitHubDownload" &&
        (await storage.exists(this.repoId)) == FILE_TYPE.NOT_FOUND) ||
      !(await FileModel.exists({ repoId: this.repoId }).exec())
    ) {
      this.model.status = RepositoryStatus.PREPARING;
      await this.updateIfNeeded({ force: true });
      return false;
    }
    return true;
  }

  /**
   * Update the repository if a new commit exists
   *
   * @returns void
   */
  async updateIfNeeded(opt?: { force: boolean }): Promise<void> {
    const span = trace
      .getTracer("ano-file")
      .startSpan("Repository.updateIfNeeded");
    span.setAttribute("repoId", this.repoId);

    if (
      this._model.options.expirationMode !== "never" &&
      this.status != RepositoryStatus.EXPIRED &&
      this._model.options.expirationDate
    ) {
      if (this._model.options.expirationDate <= new Date()) {
        this._model.status = RepositoryStatus.EXPIRED;
        await this.expire();
        throw new AnonymousError("repository_expired", {
          object: this,
          httpStatus: 410,
        });
      }
    }
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (
      opt?.force ||
      (this._model.options.update && this._model.lastView < yesterday)
    ) {
      // Only GitHubBase can be update for the moment
      if (this.source instanceof GitHubBase) {
        const token = await this.getToken();

        const ghRepo = await getRepositoryFromGitHub({
          accessToken: token,
          owner: this.source.data.organization,
          repo: this.source.data.repoName,
          repositoryID: this.model.source.repositoryId,
          force: true,
        });

        if (ghRepo.size) {
          if (
            ghRepo.size > config.AUTO_DOWNLOAD_REPO_SIZE &&
            this.model.source.type == "GitHubDownload"
          ) {
            this.model.source.type = "GitHubStream";
            await this.model.save();
          } else if (
            ghRepo.size < config.AUTO_DOWNLOAD_REPO_SIZE &&
            this.model.source.type == "GitHubStream"
          ) {
            this.model.source.type = "GitHubDownload";
            await this.model.save();
          }
        }

        // update the repository name if it has changed
        this.model.source.repositoryName = ghRepo.fullName;
        const branches = await ghRepo.branches({
          force: true,
          accessToken: token,
        });
        const branchName =
          this.model.source.branch || ghRepo.model.defaultBranch;
        const newCommit = branches.filter((f) => f.name == branchName)[0]
          ?.commit;
        if (
          this.model.source.commit == newCommit &&
          this.status == RepositoryStatus.READY
        ) {
          console.log(`[UPDATE] ${this._model.repoId} is up to date`);
          span.setAttribute("status", "up_to_date");
          span.end();
          return;
        }
        this._model.source.commit = newCommit;
        const commitInfo = await ghRepo.getCommitInfo(newCommit, {
          accessToken: token,
        });
        if (
          commitInfo.commit?.author?.date ||
          commitInfo.commit?.committer?.date
        ) {
          const d = (commitInfo.commit?.author?.date ||
            commitInfo.commit.committer?.date) as string;
          this._model.source.commitDate = new Date(d);
        }
        this.model.source.commit = newCommit;

        if (!newCommit) {
          console.error(
            `${branchName} for ${this.model.source.repositoryName} is not found`
          );
          await this.updateStatus(RepositoryStatus.ERROR, "branch_not_found");
          await this.resetSate();
          span.setAttribute("status", "branch_not_found");
          span.end();
          throw new AnonymousError("branch_not_found", {
            object: this,
          });
        }
        this._model.anonymizeDate = new Date();
        console.log(
          `[UPDATE] ${this._model.repoId} will be updated to ${newCommit}`
        );

        await this.resetSate(RepositoryStatus.PREPARING);
        await downloadQueue.add(this.repoId, this, {
          jobId: this.repoId,
          attempts: 3,
        });
      }
    }
    span.end();
  }
  /**
   * Download the require state for the repository to work
   *
   * @returns void
   */
  async anonymize(progress?: (status: string) => void) {
    const span = trace.getTracer("ano-file").startSpan("Repository.anonymize");
    span.setAttribute("repoId", this.repoId);
    if (this.status === RepositoryStatus.READY) {
      span.end();
      return;
    }
    this.model.increment();
    await this.updateStatus(RepositoryStatus.DOWNLOAD);
    const files = await this.files({
      force: false,
      progress,
      recursive: false,
    });
    if (files.length === 0) {
      // create a dummy file when the repo is empty to avoid errors
      await new FileModel({
        repoId: this.repoId,
        path: "",
        name: "",
        size: 0,
      }).save();
    }
    await this.updateStatus(RepositoryStatus.READY);
    await this.computeSize();
    span.end();
  }

  /**
   * Update the last view and view count
   */
  async countView() {
    const span = trace.getTracer("ano-file").startSpan("Repository.countView");
    span.setAttribute("repoId", this.repoId);
    try {
      this._model.lastView = new Date();
      this._model.pageView = (this._model.pageView || 0) + 1;
      if (!isConnected) return this.model;
      await this._model.save();
    } finally {
      span.end();
    }
  }

  /**
   * Update the status of the repository
   * @param status the new status
   * @param errorMessage a potential error message to display
   */
  async updateStatus(status: RepositoryStatus, statusMessage?: string) {
    const span = trace
      .getTracer("ano-file")
      .startSpan("Repository.updateStatus");
    span.setAttribute("repoId", this.repoId);
    span.setAttribute("status", status);
    span.setAttribute("statusMessage", statusMessage || "");
    try {
      if (!status) return this.model;
      this._model.status = status;
      this._model.statusDate = new Date();
      this._model.statusMessage = statusMessage;
      if (!isConnected) return this.model;
      await this._model.save();
    } finally {
      span.end();
    }
  }

  /**
   * Expire the repository
   */
  async expire() {
    const span = trace.getTracer("ano-file").startSpan("Repository.expire");
    span.setAttribute("repoId", this.repoId);
    await this.updateStatus(RepositoryStatus.EXPIRING);
    await this.resetSate();
    await this.updateStatus(RepositoryStatus.EXPIRED);
    span.end();
  }

  /**
   * Remove the repository
   */
  async remove() {
    const span = trace.getTracer("ano-file").startSpan("Repository.remove");
    span.setAttribute("repoId", this.repoId);
    await this.updateStatus(RepositoryStatus.REMOVING);
    await this.resetSate();
    await this.updateStatus(RepositoryStatus.REMOVED);
    span.end();
  }

  /**
   * Reset/delete the state of the repository
   */
  async resetSate(status?: RepositoryStatus, statusMessage?: string) {
    const span = trace.getTracer("ano-file").startSpan("Repository.resetState");
    span.setAttribute("repoId", this.repoId);
    // remove attribute
    this._model.size = { storage: 0, file: 0 };
    if (status) {
      await this.updateStatus(status, statusMessage);
    }
    // remove cache
    await Promise.all([
      FileModel.deleteMany({ repoId: this.repoId }).exec(),
      this.removeCache(),
    ]);
    console.log(`[RESET] ${this._model.repoId} has been reset`);
    span.end();
  }

  /**
   * Remove the cached files
   * @returns
   */
  async removeCache() {
    const span = trace
      .getTracer("ano-file")
      .startSpan("Repository.removeCache");
    span.setAttribute("repoId", this.repoId);
    try {
      await storage.rm(this.repoId);
      this.model.isReseted = true;
      if (isConnected) {
        try {
          await this.model.save();
        } catch (error) {
          console.error("[ERROR] removeCache save", error);
        }
      }
    } finally {
      span.end();
    }
  }

  /**
   * Compute the size of the repository in term of storage and number of files.
   *
   * @returns The size of the repository in bite
   */
  async computeSize(): Promise<{
    /**
     * Size of the repository in bit
     */
    storage: number;
    /**
     * The number of files
     */
    file: number;
  }> {
    const span = trace
      .getTracer("ano-file")
      .startSpan("Repository.computeSize");
    span.setAttribute("repoId", this.repoId);
    try {
      if (this.status !== RepositoryStatus.READY)
        return { storage: 0, file: 0 };
      if (this._model.size.file) return this._model.size;
      const res = await FileModel.aggregate([
        {
          $match: {
            repoId: this.repoId,
          },
        },
        {
          $group: {
            _id: "$repoId",
            storage: { $sum: "$size" },
            file: { $sum: 1 },
          },
        },
      ]);
      this._model.size = {
        storage: res[0]?.storage || 0,
        file: res[0]?.file || 0,
      };
      if (isConnected) {
        await this._model.save();
      }
      return this._model.size;
    } finally {
      span.end();
    }
  }

  /**
   * Returns the conference of the repository
   *
   * @returns conference of the repository
   */
  async conference(): Promise<Conference | null> {
    const span = trace.getTracer("ano-file").startSpan("Repository.conference");
    span.setAttribute("repoId", this.repoId);
    try {
      if (!this._model.conference) {
        return null;
      }
      const conference = await ConferenceModel.findOne({
        conferenceID: this._model.conference,
      });
      if (conference) return new Conference(conference);
      return null;
    } finally {
      span.end();
    }
  }

  /***** Getters ********/

  get repoId() {
    return this._model.repoId;
  }

  get options() {
    return this._model.options;
  }

  get model() {
    return this._model;
  }

  get status() {
    return this._model.status;
  }

  get size() {
    if (this.status != RepositoryStatus.READY) return { storage: 0, file: 0 };
    return this._model.size;
  }

  toJSON() {
    return {
      repoId: this._model.repoId,
      options: this._model.options,
      conference: this._model.conference,
      anonymizeDate: this._model.anonymizeDate,
      status: this.status,
      statusMessage: this._model.statusMessage,
      lastView: this._model.lastView,
      pageView: this._model.pageView,
      size: this.size,
      source: {
        repositoryID: this.model.source.repositoryId,
        fullName: this.model.source.repositoryName,
        commit: this.model.source.commit,
        branch: this.model.source.branch,
        type: this.model.source.type,
      },
    };
  }
}
