import { join } from "path";
import storage from "./storage";
import {
  FILE_TYPE,
  RepositoryStatus,
  Source,
  Tree,
  TreeElement,
  TreeFile,
} from "./types";
import { Readable } from "stream";
import User from "./User";
import GitHubStream from "./source/GitHubStream";
import GitHubDownload from "./source/GitHubDownload";
import Zip from "./source/Zip";
import { anonymizePath } from "./anonymize-utils";
import UserModel from "./database/users/users.model";
import { IAnonymizedRepositoryDocument } from "./database/anonymizedRepositories/anonymizedRepositories.types";
import { AnonymizeTransformer } from "./anonymize-utils";
import GitHubBase from "./source/GitHubBase";
import Conference from "./Conference";
import ConferenceModel from "./database/conference/conferences.model";
import AnonymousError from "./AnonymousError";
import { downloadQueue, removeQueue } from "./queue";
import { isConnected } from "./database/database";
import AnonymizedFile from "./AnonymizedFile";
import AnonymizedRepositoryModel from "./database/anonymizedRepositories/anonymizedRepositories.model";
import { getRepositoryFromGitHub } from "./source/GitHubRepository";
import config from "../config";

function anonymizeTreeRecursive(
  tree: TreeElement,
  terms: string[],
  opt: {
    /** Include the file sha in the response */
    includeSha: boolean;
  } = {
    includeSha: false,
  }
): TreeElement {
  if (typeof tree.size !== "object" && tree.sha !== undefined) {
    if (opt?.includeSha) return tree as TreeFile;
    return { size: tree.size } as TreeFile;
  }
  const output: Tree = {};
  Object.getOwnPropertyNames(tree).forEach((file) => {
    const anonymizedPath = anonymizePath(file, terms);
    output[anonymizedPath] = anonymizeTreeRecursive(
      (tree as Tree)[file],
      terms,
      opt
    );
  });
  return output;
}

export default class Repository {
  private _model: IAnonymizedRepositoryDocument;
  source: Source;
  owner: User;

  constructor(data: IAnonymizedRepositoryDocument) {
    this._model = data;
    switch (data.source.type) {
      case "GitHubDownload":
        this.source = new GitHubDownload(data.source, this);
        break;
      case "GitHubStream":
        this.source = new GitHubStream(data.source, this);
        break;
      case "Zip":
        this.source = new Zip(data.source, this);
        break;
      default:
        throw new AnonymousError("unsupported_source", {
          object: data.source.type,
          httpStatus: 400,
        });
    }
    this.owner = new User(new UserModel({ _id: data.owner }));
    this.owner.model.isNew = false;
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
    } = {
      force: false,
      includeSha: false,
    }
  ): Promise<Tree> {
    const terms = this._model.options.terms || [];
    return anonymizeTreeRecursive(await this.files(opt), terms, opt) as Tree;
  }

  /**
   * Get the file tree
   *
   * @param opt force to get an updated list of files
   * @returns The file tree
   */
  async files(opt: { force?: boolean } = { force: false }): Promise<Tree> {
    if (!this._model.originalFiles && !opt.force) {
      const res = await AnonymizedRepositoryModel.findById(this._model._id, {
        originalFiles: 1,
      });
      if (!res) throw new AnonymousError("repository_not_found");
      this.model.originalFiles = res.originalFiles;
    }
    if (
      this._model.originalFiles &&
      Object.getOwnPropertyNames(this._model.originalFiles).length !== 0 &&
      !opt.force
    ) {
      return this._model.originalFiles;
    }
    const files = await this.source.getFiles();
    this._model.originalFiles = files;
    this._model.size = { storage: 0, file: 0 };
    await this.computeSize();
    return files;
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
    return storage.archive(this.originalCachePath, {
      format: "zip",
      fileTransformer: (filename: string) =>
        new AnonymizeTransformer(
          new AnonymizedFile({
            repository: this,
            anonymizedPath: filename,
          })
        ),
    });
  }

  /**
   * Update the repository if a new commit exists
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
      // Only GitHubBase can be update for the moment
      if (this.source instanceof GitHubBase) {
        const token = await this.source.getToken();
        const branches = await this.source.githubRepository.branches({
          force: true,
          accessToken: token,
        });
        const branch = this.source.branch;
        const newCommit = branches.filter((f) => f.name == branch.name)[0]
          ?.commit;
        if (
          branch.commit == newCommit &&
          this.status == RepositoryStatus.READY
        ) {
          console.log(`[UPDATE] ${this._model.repoId} is up to date`);
          return;
        }
        this._model.source.commit = newCommit;
        const commitInfo = await this.source.githubRepository.getCommitInfo(
          newCommit,
          {
            accessToken: token,
          }
        );
        if (commitInfo.commit.author?.date) {
          this._model.source.commitDate = new Date(
            commitInfo.commit.author?.date
          );
        }
        branch.commit = newCommit;

        if (!newCommit) {
          console.error(
            `${branch.name} for ${this.source.githubRepository.fullName} is not found`
          );
          await this.updateStatus(RepositoryStatus.ERROR, "branch_not_found");
          await this.resetSate();
          throw new AnonymousError("branch_not_found", {
            object: this,
          });
        }
        this._model.anonymizeDate = new Date();
        console.log(
          `[UPDATE] ${this._model.repoId} will be updated to ${newCommit}`
        );

        if (this.source.type == "GitHubDownload") {
          const repository = await getRepositoryFromGitHub({
            accessToken: await this.source.getToken(),
            owner: this.source.githubRepository.owner,
            repo: this.source.githubRepository.repo,
          });
          if (
            repository.size === undefined ||
            repository.size > config.MAX_REPO_SIZE
          ) {
            console.log(
              `[UPDATE] ${this._model.repoId} will be streamed instead of downloaded`
            );
            this._model.source.type = "GitHubStream";
          }
        }

        await this.resetSate(RepositoryStatus.PREPARING);
        await downloadQueue.add(this.repoId, this, {
          jobId: this.repoId,
          attempts: 3,
        });
      }
    }
  }
  /**
   * Download the require state for the repository to work
   *
   * @returns void
   */
  async anonymize() {
    if (this.status === RepositoryStatus.READY) return;
    await this.updateStatus(RepositoryStatus.PREPARING);
    await this.files();
    return this.updateStatus(RepositoryStatus.READY);
  }

  /**
   * Update the last view and view count
   */
  async countView() {
    this._model.lastView = new Date();
    this._model.pageView = (this._model.pageView || 0) + 1;
    if (!isConnected) return this.model;
    return this._model.save();
  }

  /**
   * Update the status of the repository
   * @param status the new status
   * @param errorMessage a potential error message to display
   */
  async updateStatus(status: RepositoryStatus, statusMessage?: string) {
    if (!status) return this.model;
    this._model.status = status;
    this._model.statusDate = new Date();
    this._model.statusMessage = statusMessage;
    if (!isConnected) return this.model;
    return this._model.save();
  }

  /**
   * Expire the repository
   */
  async expire() {
    await this.updateStatus(RepositoryStatus.EXPIRING);
    await this.resetSate();
    await this.updateStatus(RepositoryStatus.EXPIRED);
  }

  /**
   * Remove the repository
   */
  async remove() {
    await this.updateStatus(RepositoryStatus.REMOVING);
    await this.resetSate();
    await this.updateStatus(RepositoryStatus.REMOVED);
  }

  /**
   * Reset/delete the state of the repository
   */
  async resetSate(status?: RepositoryStatus, statusMessage?: string) {
    // remove attribute
    this._model.size = { storage: 0, file: 0 };
    this._model.originalFiles = undefined;
    if (status) {
      await this.updateStatus(status, statusMessage);
    }
    // remove cache
    await this.removeCache();
    console.log(`[RESET] ${this._model.repoId} has been reset`);
  }

  /**
   * Remove the cached files
   * @returns
   */
  async removeCache() {
    this.model.isReseted = true;
    await this.model.save();
    if (
      (await storage.exists(this._model.repoId + "/")) !== FILE_TYPE.NOT_FOUND
    ) {
      return storage.rm(this._model.repoId + "/");
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
    if (this.status !== RepositoryStatus.READY) return { storage: 0, file: 0 };
    if (this._model.size.file) return this._model.size;
    function recursiveCount(files: Tree): { storage: number; file: number } {
      const out = { storage: 0, file: 0 };
      for (const name in files) {
        const file = files[name];
        if (file.size && parseInt(file.size.toString()) == file.size) {
          out.storage += file.size as number;
          out.file++;
        } else if (typeof file == "object") {
          const r = recursiveCount(file as Tree);
          out.storage += r.storage;
          out.file += r.file;
        }
      }
      return out;
    }

    const files = await this.files();
    this._model.size = recursiveCount(files);
    await this._model.save();
    return this._model.size;
  }

  /**
   * Returns the conference of the repository
   *
   * @returns conference of the repository
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

  get repoId() {
    return this._model.repoId;
  }

  get options() {
    return this._model.options;
  }

  get model() {
    return this._model;
  }

  get originalCachePath() {
    return (
      join(this._model.repoId, "original") +
      (process.platform === "win32" ? "\\" : "/")
    );
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
      source: this.source.toJSON(),
      lastView: this._model.lastView,
      pageView: this._model.pageView,
      size: this.size,
    };
  }
}
