import * as path from "path";
import storage from "./storage";
import { RepositoryStatus, Source, Tree, TreeElement, TreeFile } from "./types";
import * as stream from "stream";
import User from "./User";
import GitHubStream from "./source/GitHubStream";
import GitHubDownload from "./source/GitHubDownload";
import Zip from "./source/Zip";
import { anonymizePath } from "./anonymize-utils";
import UserModel from "./database/users/users.model";
import { IAnonymizedRepositoryDocument } from "./database/anonymizedRepositories/anonymizedRepositories.types";
import { anonymizeStream } from "./anonymize-utils";
import GitHubBase from "./source/GitHubBase";
import Conference from "./Conference";
import ConferenceModel from "./database/conference/conferences.model";
import AnonymousError from "./AnonymousError";

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
        throw new AnonymousError("unsupported_source", data.source.type);
    }
    this.owner = new User(new UserModel({ _id: data.owner }));
  }

  /**
   * Get the anonymized file tree
   * @param opt force to get an updated list of files
   * @returns The anonymized file tree
   */
  async anonymizedFiles(opt?: {
    /** Force to refresh the file tree */
    force?: boolean;
    /** Include the file sha in the response */
    includeSha: boolean;
  }): Promise<Tree> {
    const terms = this._model.options.terms || [];

    function anonymizeTreeRecursive(tree: TreeElement): TreeElement {
      if (Number.isInteger(tree.size) && tree.sha !== undefined) {
        if (opt?.includeSha) return tree as TreeFile;
        return { size: tree.size } as TreeFile;
      }
      const output: Tree = {};
      for (const file in tree) {
        const anonymizedPath = anonymizePath(file, terms);
        output[anonymizedPath] = anonymizeTreeRecursive(tree[file]);
      }
      return output;
    }

    return anonymizeTreeRecursive(await this.files(opt)) as Tree;
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
    this._model.size = { storage: 0, file: 0 };
    await this.computeSize();
    await this._model.save();

    this._model.originalFiles = files;
    return files;
  }

  /**
   * Check the status of the repository
   */
  check() {
    if (
      this._model.options.expirationMode !== "never" &&
      this._model.status == "ready"
    ) {
      if (this._model.options.expirationDate <= new Date()) {
        this.expire();
      }
    }
    if (this._model.status == "expired") {
      throw new AnonymousError("repository_expired", this);
    }
    if (this._model.status == "removed") {
      throw new AnonymousError("repository_expired", this);
    }
    if (this._model.status != "ready") {
      throw new AnonymousError("repository_not_ready", this);
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
        throw new AnonymousError("repository_not_ready", this);
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
          branches.filter((f) => f.name == branch.name)[0]?.commit
        ) {
          console.log(`${this._model.repoId} is up to date`);
          return;
        }
        this._model.source.commit = branches.filter(
          (f) => f.name == branch.name
        )[0]?.commit;

        if (!this._model.source.commit) {
          console.error(
            `${branch.name} for ${this.source.githubRepository.fullName} is not found`
          );
          throw new AnonymousError("branch_not_found", this);
        }
        this._model.anonymizeDate = new Date();
        console.log(
          `${this._model.repoId} will be updated to ${this._model.source.commit}`
        );
        await this.resetSate("preparing");
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
    await this.updateStatus("preparing");
    await this.files();
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
   * Update the status of the repository
   * @param status the new status
   * @param errorMessage a potential error message to display
   */
  async updateStatus(status: RepositoryStatus, errorMessage?: string) {
    this._model.status = status;
    this._model.errorMessage = errorMessage;
    return this._model.save();
  }

  /**
   * Expire the repository
   */
  async expire() {
    return this.resetSate("expired");
  }

  /**
   * Remove the repository
   */
  async remove() {
    return this.resetSate("removed");
  }

  /**
   * Reset/delete the state of the repository
   */
  private async resetSate(status?: RepositoryStatus) {
    if (status) this._model.status = status;
    this._model.size = { storage: 0, file: 0 };
    this._model.originalFiles = null;
    return Promise.all([
      this._model.save(),
      storage.rm(this._model.repoId + "/"),
    ]);
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
    if (this._model.status != "ready") return { storage: 0, file: 0 };
    if (this._model.size.file) return this._model.size;
    function recursiveCount(files) {
      const out = { storage: 0, file: 0 };
      for (const name in files) {
        const file = files[name];
        if (file.size) {
          out.storage += file.size as number;
          out.file++;
        } else if (typeof file == "object") {
          const r = recursiveCount(file);
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
    return new Conference(conference);
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

  get size() {
    if (this._model.status != "ready") return { storage: 0, file: 0 };
    return this._model.size;
  }

  toJSON() {
    return {
      repoId: this._model.repoId,
      options: this._model.options,
      conference: this._model.conference,
      anonymizeDate: this._model.anonymizeDate,
      status: this._model.status,
      source: this.source.toJSON(),
      lastView: this._model.lastView,
      pageView: this._model.pageView,
      size: this.size,
    };
  }
}
