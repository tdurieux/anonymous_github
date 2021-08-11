import * as path from "path";
import storage from "./storage";
import { RepositoryStatus, Source, Tree } from "./types";
import * as stream from "stream";
import User from "./User";
import GitHubStream from "./source/GitHubStream";
import GitHubDownload from "./source/GitHubDownload";
import Zip from "./source/ZIP";
import { anonymizePath } from "./anonymize-utils";
import UserModel from "./database/users/users.model";
import { IAnonymizedRepositoryDocument } from "./database/anonymizedRepositories/anonymizedRepositories.types";
import { anonymizeStream } from "./anonymize-utils";
import GitHubBase from "./source/GitHubBase";

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
        throw new Error("unsupported_source");
    }
    this.owner = new User(new UserModel({ username: data.owner }));
  }

  /**
   * Get the anonymized file tree
   * @param opt force to get an updated list of files
   * @returns The anonymized file tree
   */
  async anonymizedFiles(opt?: { force?: boolean }): Promise<Tree> {
    const terms = this._model.options.terms || [];

    function anonymizeTreeRecursive(tree: Tree): any {
      if (Number.isInteger(tree.size)) {
        return tree;
      }
      const output: any = {};
      let current: any = tree;
      if (current.child) {
        current = current.child;
      }
      for (const file in current) {
        const anonymizedPath = anonymizePath(file, terms);
        output[anonymizedPath] = anonymizeTreeRecursive(current[file]);
      }
      return output;
    }

    return anonymizeTreeRecursive(await this.files(opt));
  }

  /**
   * Get the file tree
   *
   * @param opt force to get an updated list of files
   * @returns The file tree
   */
  async files(opt?: { force?: boolean }) {
    if (
      this._model.originalFiles &&
      Object.keys(this._model.originalFiles).length !== 0 &&
      !opt?.force
    ) {
      return this._model.originalFiles;
    }
    const files = await this.source.getFiles();
    this._model.originalFiles = files;
    this._model.size = 0;
    await this._model.save();

    this._model.originalFiles = files;
    return files;
  }

  check() {
    if (this._model.options.expirationMode != "never") {
      if (this._model.options.expirationDate > new Date()) {
        this.updateStatus("expired");
      }
    }
    if (this._model.status == "expired") {
      throw new Error("repository_expired");
    }
    if (this._model.status == "removed") {
      throw new Error("repository_expired");
    }
    if (this._model.status != "ready") {
      throw new Error("repository_not_ready");
    }
  }

  /**
   * Compress and anonymize the repository
   *
   * @returns A stream of anonymized repository compressed
   */
  zip(): stream.Readable {
    return storage.archive(this.originalCachePath, {
      format: "zip",
      fileTransformer: (filename) =>
        anonymizeStream(filename, this) as Transformer,
    });
  }

  /**
   * Update the repository if a new commit exists
   *
   * @returns void
   */
  async updateIfNeeded(): Promise<void> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    if (this._model.options.update && this._model.lastView < yesterday) {
      if (this._model.status != "ready") {
        throw new Error("repo_not_ready");
      }

      // Only GitHubBase can be update for the moment
      if (this.source instanceof GitHubBase) {
        const branches = await this.source.githubRepository.branches({
          force: true,
          accessToken: await this.source.getToken(),
        });
        const branch = this.source.branch;
        if (
          branch.commit ==
          branches.filter((f) => f.name == branch.name)[0].commit
        ) {
          console.log(`${this._model.repoId} is up to date`);
          return;
        }
        this._model.source.commit = branches.filter(
          (f) => f.name == branch.name
        )[0].commit;
        this._model.anonymizeDate = new Date();
        await this.updateStatus("preparing");
        console.log(
          `${this._model.repoId} will be updated to ${this._model.source.commit}`
        );
        await this.resetSate();
        await this.anonymize();
      }
    }
  }

  /**
   * Download the require state for the repository to work
   *
   * @returns void
   */
  async anonymize() {
    if (this._model.status == "ready") return;
    await this.updateStatus("queue");
    await this.files();
    await this.updateStatus("ready");
  }

  /**
   * Update the last view and view count
   */
  async countView() {
    this._model.lastView = new Date();
    this._model.pageView = (this._model.pageView || 0) + 1;
    await this._model.save();
  }

  /**
   * Update the status of the repository
   * @param status the new status
   * @param errorMessage a potential error message to display
   */
  async updateStatus(status: RepositoryStatus, errorMessage?: string) {
    this._model.status = status;
    this._model.errorMessage = errorMessage;
    this._model.status = status;
    await this._model.save();
  }

  /**
   * Expire the repository
   */
  async expire() {
    await this.updateStatus("expired");
    await this.resetSate();
  }

  /**
   * Remove the repository
   */
  async remove() {
    this._model.size = 0;
    await this.resetSate();
  }

  /**
   * Reset/delete the state of the repository
   */
  private async resetSate() {
    this._model.size = 0;
    this._model.originalFiles = null;
    await this._model.save();
    await storage.rm(this._model.repoId + "/");
  }

  /**
   * Compute the size of the repository in bite.
   *
   * @returns The size of the repository in bite
   */
  async computeSize(): Promise<number> {
    if (this._model.status != "ready") return 0;
    if (this._model.size) return this._model.size;
    function recursiveCount(files) {
      let total = 0;
      for (const name in files) {
        const file = files[name];
        if (file.size) {
          total += file.size as number;
        } else if (typeof file == "object") {
          total += recursiveCount(file);
        }
      }
      return total;
    }

    const files = await this.files({ force: false });
    this._model.size = recursiveCount(files);
    await this._model.save();
    return this._model.size;
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
    return path.join(this._model.repoId, "original") + "/";
  }

  get status() {
    return this._model.status;
  }

  toJSON() {
    return {
      repoId: this._model.repoId,
      options: this._model.options,
      anonymizeDate: this._model.anonymizeDate,
      status: this._model.status,
      source: this.source.toJSON(),
      lastView: this._model.lastView,
      pageView: this._model.pageView,
      size: this._model.size,
    };
  }
}
