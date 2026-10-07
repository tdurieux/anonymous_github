import AnonymizedPathModel from "./model/anonymized-path";
import storage from "./storage";
import { createHash, randomUUID } from "crypto";
import { RepositoryStatus } from "./types";
import { Readable } from "stream";
import * as sha1 from "crypto-js/sha1";
import User from "./User";
import GitHubStream from "./source/GitHubStream";
import Zip from "./source/Zip";
import {
  anonymizePathCompiled,
  compileTerms,
  hasCustomTermReplacement,
} from "./anonymize-utils";
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
import { getToken } from "./GitHubUtils";
import config from "../config";
import FileModel from "./model/files/files.model";
import AnonymizedRepositoryModel from "./model/anonymizedRepositories/anonymizedRepositories.model";
import { createLogger, serializeError } from "./logger";

const logger = createLogger("repository");
const pathIndexes = new Map<string, Promise<void>>();
async function buildPathIndex(repoId: string, key: string, terms: string[], generation?: string) {
  const cacheKey = `${repoId}:${key}`;
  const existing = pathIndexes.get(cacheKey);
  if (existing) return existing;
  const task = (async () => {
    const compiled = compileTerms(terms);
    const cursor = FileModel.find({ repoId, treeGeneration: generation || { $exists: false } })
      .select("name path sha size").sort({ path: 1, name: 1 }).lean().cursor();
    let batch: Parameters<typeof AnonymizedPathModel.bulkWrite>[0] = [];
    try {
      for await (const file of cursor) {
        const name = anonymizePathCompiled(file.name, compiled);
        const directory = anonymizePathCompiled(file.path, compiled);
        batch.push({ updateOne: { filter: { repoId, key, originalId: file._id }, update: { $set: {
          repoId, key, originalId: file._id, name: file.name, path: file.path, sha: file.sha, size: file.size,
          anonymousName: name, anonymousDirectory: directory, createdAt: new Date(),
          searchName: name.toLowerCase(), searchDirectory: directory.toLowerCase(),
          anonymousPath: anonymizePathCompiled(file.path ? `${file.path}/${file.name}` : file.name, compiled),
        } }, upsert: true } });
        if (batch.length === 250) { await AnonymizedPathModel.bulkWrite(batch); batch = []; }
      }
      if (batch.length) await AnonymizedPathModel.bulkWrite(batch);
    } finally { await cursor.close(); }
  })();
  // Retain only in-flight work. A subsequent recovery can add file rows.
  pathIndexes.set(cacheKey, task);
  try { await task; } finally { pathIndexes.delete(cacheKey); }
}
import { IFile, IFileDocument } from "./model/files/files.types";
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
  const compiled = compileTerms(terms);
  return tree.map((file) => {
    return {
      name: anonymizePathCompiled(file.name, compiled),
      path: anonymizePathCompiled(file.path, compiled),
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
    this.owner.model.isNew = false;
  }

  async getToken() {
    this.assertNotArchived();
    return getToken(this);
  }

  get source() {
    this.assertNotArchived();
    const ghRepo = new GitHubRepository({
      name: this.model.source.repositoryName,
    });
    if (this.model.source.type === "Zip") {
      return new Zip(this.model.source, this.repoId);
    }
    return new GitHubStream({
      repoId: this.repoId,
      commit: this.model.source.commit || "HEAD",
      cacheGeneration: `${this.model.treeGeneration || "legacy"}:${this.model.anonymizeDate?.toISOString() || ""}`,
      organization: ghRepo.owner,
      repoName: ghRepo.repo,
      getToken: () => this.getToken(),
    });
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
    await this.ensureFileTree(opt);
    const terms = this._model.options.terms || [];
    if (
      opt.path &&
      (opt.path.includes(config.ANONYMIZATION_MASK) ||
        hasCustomTermReplacement(terms))
    ) {
      const f = new AnonymizedFile({
        repository: this,
        anonymizedPath: opt.path,
      });
      opt.path = await f.originalPath();
    }

    const escapedPath = opt.path
      ? opt.path.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")
      : undefined;
    let pathQuery: string | RegExp | undefined = escapedPath
      ? new RegExp(`^${escapedPath}`)
      : undefined;
    if (opt.recursive === false) {
      pathQuery = escapedPath ? new RegExp(`^${escapedPath}$`) : "";
    }

    const query: FilterQuery<IFile> = {
      repoId: this.repoId,
      treeGeneration: this.model.treeGeneration || { $exists: false },
    };
    if (pathQuery !== undefined) {
      query.path = pathQuery;
    }
    return await FileModel.find(query).exec();
  }

  private async ensureFileTree(opt: { force?: boolean; progress?: (status: string) => void } = {}) {
    this.assertNotArchived();
    let hasFile = this.hasEmptyTree() || await FileModel.exists({ repoId: this.repoId, treeGeneration: this.model.treeGeneration || { $exists: false } }).exec();
    // Files created by GitHubDownload don't carry a valid 40-char GitHub
    // blob SHA.  When the source type later switches to GitHubStream the
    // stale entries cause blob-API 404s.  Detect this by sampling a file
    // with a sha and checking its length; force a re-fetch if it doesn't
    // look like a GitHub SHA.
    if (hasFile && this.source instanceof GitHubStream) {
      const sample = await FileModel.findOne(
        { repoId: this.repoId, treeGeneration: this.model.treeGeneration || { $exists: false }, sha: { $exists: true, $ne: null } },
        { sha: 1 }
      ).exec();
      if (sample?.sha && sample.sha.length !== 40) {
        hasFile = null;
      }
    }
    if (!hasFile || opt.force) {
      const previousGeneration = this.model.treeGeneration;
      const source = this.source;
      const files = await source.getFiles(opt.progress);
      this._model.treeGeneration = randomUUID();
      files.forEach(f => { f.repoId = this.repoId; f.treeGeneration = this.model.treeGeneration; });
      const generation = this.model.treeGeneration;
      await FileModel.insertMany(files);
      if (isConnected) {
        const activated = await AnonymizedRepositoryModel.updateOne({ _id: this.model._id,
          treeGeneration: previousGeneration || { $exists: false }, ...this.refreshFilter(),
          status: this.model.status, statusDate: this.model.statusDate,
          "githubAccess.revision": this.model.githubAccess?.revision || { $exists: false },
        }, { $set: { treeGeneration: generation, size: { storage: 0, file: 0 },
          ...(!files.length ? { emptyTreeGeneration: generation } : {}),
        }, $unset: { pathIndexKey: "", pathIndexBuiltAt: "", sizeComputedAt: "",
          ...(files.length ? { emptyTreeGeneration: "" } : {}),
        }, $addToSet: { retiredTreeGenerations: previousGeneration || "" } }).exec();
        if (!activated.matchedCount) {
          await FileModel.deleteMany({ repoId: this.repoId, treeGeneration: generation }).exec();
          this.model.treeGeneration = previousGeneration;
          throw new AnonymousError("repository_changed", { httpStatus: 409 });
        }
      }
      this.model.emptyTreeGeneration = files.length ? undefined : generation;
      if (isConnected) {
        await this.cleanupRetiredFileTrees().catch(error => logger.warn("retired tree cleanup deferred", serializeError(error)));
      } else {
        await FileModel.deleteMany({ repoId: this.repoId, treeGeneration: previousGeneration || { $exists: false } }).exec();
      }

      const sourceWithTruncation = source as unknown as {
        truncatedFolderList?: string[];
      };
      if (Array.isArray(sourceWithTruncation.truncatedFolderList)) {
        this._model.truncatedFolders = sourceWithTruncation.truncatedFolderList;
      }

      this._model.size = { storage: 0, file: 0 };
      this._model.sizeComputedAt = undefined;
      await this.computeSize();
      if (isConnected) {
        await AnonymizedRepositoryModel.updateOne(
          { _id: this._model._id, treeGeneration: this.model.treeGeneration },
          {
            $set: {
              treeGeneration: this._model.treeGeneration,
              truncatedFolders: this._model.truncatedFolders,
              size: this._model.size,
            },
          }
        ).exec();
      }
    }
  }

  /** Activation records retirement atomically; maintenance retries interrupted deletion. */
  async cleanupRetiredFileTrees() {
    const current = await AnonymizedRepositoryModel.findById(this.model._id)
      .select("treeGeneration retiredTreeGenerations").lean().exec();
    if (!current) return;
    const retired = (current.retiredTreeGenerations || []).filter(generation => generation !== (current.treeGeneration || ""));
    if (retired.length) {
      await FileModel.deleteMany({ repoId: this.repoId, $or: [
        { treeGeneration: { $in: retired.filter(Boolean) } },
        ...(retired.includes("") ? [{ treeGeneration: { $exists: false } }] : []),
      ] }).exec();
      await AnonymizedRepositoryModel.updateOne({ _id: this.model._id },
        { $pull: { retiredTreeGenerations: { $in: retired } } }).exec();
    }
    await AnonymizedRepositoryModel.updateOne({ _id: this.model._id, "retiredTreeGenerations.0": { $exists: false } },
      { $unset: { retiredTreeGenerations: "" } }).exec();
  }

  private pathKey() {
    return createHash("sha256").update(JSON.stringify([
      "paths-v2", config.ANONYMIZATION_MASK, this.options.terms,
      this.model.treeGeneration, this.model.fileMetadataRevision, this.model.source.commit, this.model.anonymizeDate,
    ])).digest("hex");
  }

  private async indexPaths() {
    if (this.status && [RepositoryStatus.EXPIRING, RepositoryStatus.EXPIRED,
      RepositoryStatus.REMOVING, RepositoryStatus.REMOVED].includes(this.status)) {
      throw new AnonymousError("repository_changed", { httpStatus: 409 });
    }
    await this.ensureFileTree();
    const metadataRevision = this.model.fileMetadataRevision;
    const key = this.pathKey();
    if (this.model.pathIndexKey !== key || !this.model.pathIndexBuiltAt || this.model.pathIndexBuiltAt.getTime() < Date.now() - 24 * 3600_000) {
      try {
        await buildPathIndex(this.repoId, key, this.options.terms || [], this.model.treeGeneration);
        const builtAt = new Date();
        const result = await AnonymizedRepositoryModel.updateOne({ _id: this.model._id,
          status: this.model.status, statusDate: this.model.statusDate,
          treeGeneration: this.model.treeGeneration || { $exists: false },
          fileMetadataRevision: metadataRevision || { $exists: false },
          "source.commit": this.model.source.commit || { $exists: false },
          "options.terms": this.options.terms || [], anonymizeDate: this.model.anonymizeDate,
        }, { $set: { pathIndexKey: key, pathIndexBuiltAt: builtAt } }).exec();
        if (!result.matchedCount) throw new AnonymousError("repository_changed", { httpStatus: 409 });
        this.model.pathIndexKey = key;
        this.model.pathIndexBuiltAt = builtAt;
      } catch (error) {
        // A reset invalidates this revision. Never delete a valid shared key
        // merely because one of its concurrent builders failed.
        const current = await AnonymizedRepositoryModel.exists({ _id: this.model._id,
          fileMetadataRevision: metadataRevision || { $exists: false },
        }).exec();
        if (!current) await AnonymizedPathModel.deleteMany({ repoId: this.repoId, key }).exec();
        throw error;
      }
      // TTL retires superseded mappings. An older builder must never delete
      // mappings activated by a newer settings or metadata generation.
    }
    return key;
  }

  async findAnonymizedPath(path: string): Promise<IFile | null | undefined> {
    if (!isConnected) return undefined;
    const key = await this.indexPaths();
    // Original paths retain priority; collisions between transformed paths
    // resolve consistently in original path/name order.
    return AnonymizedPathModel.findOne({ repoId: this.repoId, key, anonymousPath: path })
      .sort({ path: 1, name: 1 }).lean().exec();
  }

  async invalidateFileMetadata() {
    const revision = randomUUID();
    this.model.pathIndexKey = undefined;
    this.model.pathIndexBuiltAt = undefined;
    this.model.sizeComputedAt = undefined;
    this.model.size = { storage: 0, file: 0 };
    if (isConnected) {
      const result = await AnonymizedRepositoryModel.updateOne({ _id: this.model._id,
        treeGeneration: this.model.treeGeneration || { $exists: false },
        status: this.model.status, statusDate: this.model.statusDate,
        anonymizeDate: this.model.anonymizeDate,
      }, { $set: { size: this.model.size, fileMetadataRevision: revision }, $unset: { pathIndexKey: "", pathIndexBuiltAt: "", sizeComputedAt: "" } }).exec();
      if (!result.matchedCount) throw new AnonymousError("repository_changed", { httpStatus: 409 });
    }
    this.model.fileMetadataRevision = revision;
  }

  async completeRecoveredFileMetadata(file: IFileDocument) {
    await this.invalidateFileMetadata();
    await FileModel.updateOne({ _id: file._id, metadataPending: true },
      { $unset: { metadataPending: "" } }).exec();
    file.metadataPending = undefined;
  }

  async searchFiles(query: string): Promise<Partial<IFile>[]> {
    const q = query.toLowerCase();
    if (q.includes("/")) return [];
    if (isConnected) {
      const key = await this.indexPaths();
      const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const rows = await AnonymizedPathModel.find({ repoId: this.repoId, key,
        $or: [{ searchName: pattern }, { searchDirectory: pattern }] })
        .select("anonymousName anonymousDirectory size").limit(500).lean().exec();
      return rows.map(f => ({ name: f.anonymousName, path: f.anonymousDirectory, size: f.size }));
    }
    const matches: Partial<IFile>[] = [];
    for (const f of await this.anonymizedFiles({ includeSha: false, recursive: true })) {
      if (f.name?.toLowerCase().includes(q) || (f.path || "").split("/").some(segment => segment.toLowerCase().includes(q))) {
        matches.push({ name: f.name, path: f.path, size: f.size });
        if (matches.length === 500) break;
      }
    }
    return matches;
  }

  /**
   * Check the status of the repository
   */
  assertNotArchived() {
    if (this.status === RepositoryStatus.ARCHIVED) {
      throw new AnonymousError("repository_archived", { httpStatus: 410 });
    }
  }

  async check() {
    this.assertNotArchived();
    if (
      this._model.options.expirationMode !== "never" &&
      this.status == RepositoryStatus.READY &&
      this._model.options.expirationDate
    ) {
      if (this._model.options.expirationDate <= new Date()) {
        await this.markExpired();
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
      this.status == RepositoryStatus.QUEUE ||
      (this.status == RepositoryStatus.DOWNLOAD &&
        this._model.statusDate > fiveMinuteAgo)
    ) {
      const rlMatch = (this._model.statusMessage || "").match(/^rate_limited:(\d+)$/);
      if (rlMatch) {
        throw new AnonymousError("rate_limited", {
          httpStatus: 425,
          object: { resetAt: parseInt(rlMatch[1], 10) },
        });
      }
      throw new AnonymousError("repository_not_ready", {
        object: this,
        httpStatus: 425,
      });
    }
  }

  /**
   * Compress and anonymize the repository
   *
   * @returns A stream of anonymized repository compressed
   */
  zip(): Promise<Readable> {
    this.assertNotArchived();
    return storage.archive(this.repoId, "", {
      format: "zip",
      fileTransformer: (filename: string) =>
        this.generateAnonymizeTransformer(filename),
    });
  }

  generateAnonymizeTransformer(filePath: string) {
    return new AnonymizeTransformer({
      filePath: filePath,
      cacheGeneration: `${this.model.treeGeneration || "legacy"}:${this.model.anonymizeDate?.toISOString() || ""}`,
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
    if (!this.hasEmptyTree() && !(await FileModel.exists({ repoId: this.repoId, treeGeneration: this.model.treeGeneration || { $exists: false } }).exec())) {
      this.model.status = RepositoryStatus.PREPARING;
      await this.updateIfNeeded({ force: true });
      return false;
    }
    return true;
  }

  private hasEmptyTree() {
    return !!this.model.treeGeneration && this.model.emptyTreeGeneration === this.model.treeGeneration;
  }

  private refreshToken?: string;

  private refreshFilter() {
    return this.refreshToken ? {
      refreshToken: this.refreshToken,
      refreshUntil: { $gt: new Date() },
      status: this.model.status,
      statusDate: this.model.statusDate || { $exists: false },
      "githubAccess.revision": this.model.githubAccess?.revision || { $exists: false },
    } : {};
  }

  private checkRefreshWrite(result: { matchedCount: number }) {
    if (this.refreshToken && !result.matchedCount) {
      throw new AnonymousError("invalid_status", { httpStatus: 409 });
    }
  }

  /** Serialize dashboard refreshes across server processes without hiding a ready snapshot. */
  async refresh() {
    this.assertNotArchived();
    if (!isConnected) return this.updateIfNeeded({ force: true });
    const token = randomUUID();
    const now = new Date();
    const claimed = await AnonymizedRepositoryModel.updateOne({
      _id: this.model._id,
      status: this.model.status,
      statusDate: this.model.statusDate || { $exists: false },
      "githubAccess.revision": this.model.githubAccess?.revision || { $exists: false },
      $or: [{ refreshUntil: { $exists: false } }, { refreshUntil: { $lte: now } }],
    }, { $set: { refreshToken: token, refreshUntil: new Date(now.getTime() + 5 * 60_000) } }).exec();
    if (!claimed.matchedCount) throw new AnonymousError("invalid_status", { httpStatus: 409 });
    this.refreshToken = token;
    try {
      // An old timestamp can still belong to a live worker. Reusing its job ID
      // would discard the replacement and cancel the old worker's generation.
      const job = await downloadQueue.getJob(`repo-${this.repoId}`);
      if (job) {
        const state = await job.getState();
        if (state !== "completed" && state !== "failed") {
          throw new AnonymousError("invalid_status", { httpStatus: 409 });
        }
        await job.remove();
      }
      await this.updateIfNeeded({ force: true });
    } catch (error) {
      if (this.status === RepositoryStatus.PREPARING) {
        // A failed reset/enqueue must remain retryable, even if the lease
        // expired. Never change a replacement lease or a concurrent removal.
        await AnonymizedRepositoryModel.updateOne({
          _id: this.model._id, refreshToken: token,
          status: RepositoryStatus.PREPARING, statusDate: this.model.statusDate,
        }, { $set: { status: RepositoryStatus.ERROR, statusDate: new Date(), statusMessage: "preparation_interrupted" } }).exec();
      }
      throw error;
    } finally {
      this.refreshToken = undefined;
      // Only this lease may be released, including after a failed GitHub lookup.
      await AnonymizedRepositoryModel.updateOne({ _id: this.model._id, refreshToken: token },
        { $unset: { refreshToken: 1, refreshUntil: 1 } }).exec();
    }
  }

  /** Update the repository if a new commit exists. */
  async updateIfNeeded(opt?: { force: boolean }): Promise<void> {
    this.assertNotArchived();
    if (
      this._model.options.expirationMode !== "never" &&
      this.status != RepositoryStatus.EXPIRED &&
      this._model.options.expirationDate
    ) {
      if (this._model.options.expirationDate <= new Date()) {
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

        // update the repository name if it has changed. Persist it
        // immediately — otherwise, when the commit is unchanged and the
        // function returns early below, the renamed value lives in this
        // in-memory model only and the next request reloads the stale
        // name from MongoDB and re-runs the rename detection forever.
        if (this.model.source.repositoryName !== ghRepo.fullName) {
          this.model.source.repositoryName = ghRepo.fullName;
          if (isConnected) {
            const result = await AnonymizedRepositoryModel.updateOne(
              { _id: this._model._id, ...this.refreshFilter() },
              { $set: { "source.repositoryName": ghRepo.fullName } }
            ).exec();
            this.checkRefreshWrite(result);
          }
        }
        const branches = await ghRepo.branches({
          force: true,
          accessToken: token,
        });
        const branchName =
          this.model.source.branch || ghRepo.model.defaultBranch;
        const newCommit = branches.filter((f) => f.name == branchName)[0]
          ?.commit;

        if (!newCommit) {
          logger.error("branch not found", {
            code: "branch_not_found",
            httpStatus: 404,
            repoId: this.repoId,
            branch: branchName,
            repo: this.model.source.repositoryName,
          });
          await this.updateStatus(RepositoryStatus.ERROR, "branch_not_found");
          await this.resetSate();
          throw new AnonymousError("branch_not_found", {
            object: this,
            httpStatus: 404,
          });
        }
        if (
          this.model.source.commit == newCommit &&
          this.status == RepositoryStatus.READY
        ) {
          logger.info("up to date", { repoId: this._model.repoId });
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
        this._model.anonymizeDate = new Date();
        logger.info("update queued", {
          repoId: this._model.repoId,
          commit: newCommit,
        });

        const statusDate = new Date();
        if (isConnected) {
          const result = await AnonymizedRepositoryModel.updateOne(
            { _id: this._model._id, ...this.refreshFilter() },
            {
              $set: {
                "source.commit": newCommit,
                "source.commitDate": this._model.source.commitDate,
                anonymizeDate: this._model.anonymizeDate,
                status: RepositoryStatus.PREPARING,
                statusDate,
                statusMessage: null,
              },
            }
          ).exec();
          this.checkRefreshWrite(result);
        }
        this.model.status = RepositoryStatus.PREPARING;
        this.model.statusDate = statusDate;
        this.model.statusMessage = undefined;
        await this.resetSate();
        if (isConnected && this.refreshToken) {
          // Removal or expiry may have started while deleting the old cache.
          const current = await AnonymizedRepositoryModel.exists({ _id: this.model._id, ...this.refreshFilter() });
          if (!current) throw new AnonymousError("invalid_status", { httpStatus: 409 });
        }
        await downloadQueue.add(this.repoId, { repoId: this.repoId }, {
          jobId: `repo-${this.repoId}`,
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
  async anonymize(progress?: (status: string) => void) {
    this.assertNotArchived();
    if (this.status === RepositoryStatus.READY) {
      return;
    }
    this.model.increment();
    await this.updateStatus(RepositoryStatus.DOWNLOAD);
    await this.files({
      force: false,
      progress,
      recursive: false,
    });
    // Previously inserted a dummy {path:"", name:"", size:0} FileModel
    // here for empty repos "to avoid errors" — but that record collides
    // with the special-case in AnonymizedFile.getFileInfo for the empty
    // path, surfaces in unfiltered file listings, and breaks anything
    // that assumes FileModel rows correspond to real files. Empty repos
    // are handled by the route layer; nothing to materialise here.
    await this.updateStatus(RepositoryStatus.READY);
    await this.computeSize();
  }

  /**
   * Update the last view and view count
   */
  async countView() {
    this._model.lastView = new Date();
    this._model.pageView = (this._model.pageView || 0) + 1;
    if (!isConnected) return this.model;
    await AnonymizedRepositoryModel.updateOne(
      { _id: this._model._id },
      {
        $set: { lastView: this._model.lastView },
        $inc: { pageView: 1 },
      }
    ).exec();
  }

  /**
   * Update the status of the repository
   * @param status the new status
   * @param errorMessage a potential error message to display
   */
  public protectLifecycle = false;

  async updateStatus(status: RepositoryStatus, statusMessage?: string) {
    if (status !== RepositoryStatus.ARCHIVED) this.assertNotArchived();
    if (!status) return this.model;
    const statusDate = new Date();
    const publishedAt = status === RepositoryStatus.READY && this.status !== RepositoryStatus.READY
      ? statusDate : undefined;
    if (isConnected) {
      const result = await AnonymizedRepositoryModel.updateOne(
        {
          _id: this._model._id,
          ...this.refreshFilter(),
          ...(this.protectLifecycle ? {
            status: { $nin: [RepositoryStatus.ARCHIVED, RepositoryStatus.REMOVING, RepositoryStatus.REMOVED,
              RepositoryStatus.EXPIRING, RepositoryStatus.EXPIRED] },
            anonymizeDate: this._model.anonymizeDate,
            "githubAccess.revision": this._model.githubAccess?.revision || { $exists: false },
          } : {}),
        },
        { $set: { status, statusDate, statusMessage, ...(publishedAt ? { publishedAt } : {}) } }
      ).exec();
      this.checkRefreshWrite(result);
      if (this.protectLifecycle && result.matchedCount === 0) {
        throw new AnonymousError("repository_job_cancelled", { httpStatus: 410 });
      }
    }
    if (publishedAt) this._model.publishedAt = publishedAt;
    this._model.status = status;
    this._model.statusDate = statusDate;
    this._model.statusMessage = statusMessage;
  }

  /**
   * Expire the repository
   */
  async markExpired(force = false) {
    const inactive = [RepositoryStatus.ARCHIVED, RepositoryStatus.REMOVED,
      RepositoryStatus.REMOVING, RepositoryStatus.EXPIRED, RepositoryStatus.EXPIRING];
    if (force && this.status && inactive.includes(this.status)) return;
    const now = new Date();
    if (isConnected) {
      const result = await AnonymizedRepositoryModel.updateOne({ _id: this.model._id,
        status: force ? { $nin: inactive } : RepositoryStatus.READY, ...(force ? {} : { "options.expirationMode": { $ne: "never" },
        "options.expirationDate": { $lte: now } }),
      }, { $set: { status: RepositoryStatus.EXPIRING, statusDate: now } }).exec();
      if (!result.matchedCount && force) return;
    }
    this.model.status = RepositoryStatus.EXPIRING;
    this.model.statusDate = now;
  }

  async expire() {
    if (!isConnected) {
      await this.updateStatus(RepositoryStatus.EXPIRING);
      await this.resetSate();
      await this.updateStatus(RepositoryStatus.EXPIRED);
      return;
    }
    const now = new Date(), token = randomUUID(), revision = randomUUID();
    const pending = this.status === RepositoryStatus.EXPIRING || this.status === RepositoryStatus.EXPIRED;
    if (!pending && (this.options.expirationMode === "never" || !this.options.expirationDate
      || this.options.expirationDate > now)) return;
    if (this.status && [RepositoryStatus.ARCHIVED, RepositoryStatus.REMOVING, RepositoryStatus.REMOVED].includes(this.status)) return;
    const claimed = await AnonymizedRepositoryModel.updateOne({ _id: this.model._id,
      status: this.model.status, statusDate: this.model.statusDate,
      anonymizeDate: this.model.anonymizeDate,
      treeGeneration: this.model.treeGeneration || { $exists: false },
      fileMetadataRevision: this.model.fileMetadataRevision || { $exists: false },
      settingsSavedAt: this.model.settingsSavedAt || { $exists: false },
      "options.expirationMode": this.options.expirationMode || { $exists: false },
      "options.expirationDate": this.options.expirationDate || { $exists: false },
      "githubAccess.revision": this.model.githubAccess?.revision || { $exists: false },
      $or: [{ cleanupUntil: { $exists: false } }, { cleanupUntil: { $lte: now } }],
    }, { $set: { status: RepositoryStatus.EXPIRING, statusDate: now,
      fileMetadataRevision: revision, cleanupToken: token, cleanupUntil: new Date(now.getTime() + 15 * 60_000) },
      $unset: { pathIndexKey: "", pathIndexBuiltAt: "" },
    }).exec();
    if (!claimed.matchedCount) return;
    this.model.status = RepositoryStatus.EXPIRING;
    this.model.statusDate = now;
    this.model.fileMetadataRevision = revision;
    this.model.pathIndexKey = undefined;
    this.model.pathIndexBuiltAt = undefined;
    const lease = { _id: this.model._id, status: RepositoryStatus.EXPIRING, cleanupToken: token,
      treeGeneration: this.model.treeGeneration || { $exists: false }, fileMetadataRevision: revision };
    const heartbeat = setInterval(() => {
      void AnonymizedRepositoryModel.updateOne(lease, { $set: { cleanupUntil: new Date(Date.now() + 15 * 60_000) } }).exec().catch(() => {});
    }, 30_000);
    heartbeat.unref();
    try {
      // The claimed lifecycle blocks restoration until the entire storage
      // root, including empty directories and older cache generations, is gone.
      if (!await AnonymizedRepositoryModel.exists(lease).exec()) return;
      await storage.rm(this.repoId);
      if (!await AnonymizedRepositoryModel.exists(lease).exec()) return;
      await FileModel.deleteMany({ repoId: this.repoId }).exec();
      await AnonymizedPathModel.deleteMany({ repoId: this.repoId }).exec();
      const result = await AnonymizedRepositoryModel.updateOne(lease, { $set: { status: RepositoryStatus.EXPIRED,
        statusDate: new Date(), isReseted: true, size: { storage: 0, file: 0 } },
        $unset: { cleanupToken: "", cleanupUntil: "", pathIndexKey: "", pathIndexBuiltAt: "", sizeComputedAt: "", emptyTreeGeneration: "", retiredTreeGenerations: "" } }).exec();
      if (result.matchedCount) { this.model.status = RepositoryStatus.EXPIRED; this.model.isReseted = true; this.model.size = { storage: 0, file: 0 }; this.model.sizeComputedAt = undefined; this.model.emptyTreeGeneration = undefined; }
    } finally {
      clearInterval(heartbeat);
      await AnonymizedRepositoryModel.updateOne({ _id: this.model._id, cleanupToken: token }, { $unset: { cleanupToken: "", cleanupUntil: "" } }).exec();
    }
  }

  /**
   * Remove the repository
   */
  async remove(expected?: { accessRevision?: string }) {
    if (expected) {
      // Claim the lifecycle before deleting files; migration rejects REMOVING.
      this.assertNotArchived();
      const result = await AnonymizedRepositoryModel.updateOne({ _id: this.model._id,
        status: this.model.status,
        "githubAccess.revision": expected.accessRevision || { $exists: false },
      }, { $set: { status: RepositoryStatus.REMOVING, statusDate: new Date() } });
      if (!result.matchedCount) throw new AnonymousError("connection_changed", { httpStatus: 409 });
      this.model.status = RepositoryStatus.REMOVING;
    } else {
      await this.updateStatus(RepositoryStatus.REMOVING);
    }
    await this.resetSate();
    await this.updateStatus(RepositoryStatus.REMOVED);
  }

  /**
   * Reset/delete the state of the repository
   */
  async resetSate(status?: RepositoryStatus, statusMessage?: string) {
    this.assertNotArchived();
    const revision = randomUUID();
    this.model.emptyTreeGeneration = undefined;
    if (isConnected) {
      const result = await AnonymizedRepositoryModel.updateOne({ _id: this.model._id,
      treeGeneration: this.model.treeGeneration || { $exists: false },
      }, { $set: { fileMetadataRevision: revision },
        $unset: { emptyTreeGeneration: "", pathIndexKey: "", pathIndexBuiltAt: "" },
      }).exec();
      if (!result.matchedCount) throw new AnonymousError("repository_changed", { httpStatus: 409 });
    }
    this.model.fileMetadataRevision = revision;
    this.model.pathIndexKey = undefined;
    this.model.pathIndexBuiltAt = undefined;
    // remove attribute
    this._model.size = { storage: 0, file: 0 };
    if (status) {
      await this.updateStatus(status, statusMessage);
    }
    // remove cache
    await Promise.all([
      FileModel.deleteMany({ repoId: this.repoId }).exec(),
      AnonymizedPathModel.deleteMany({ repoId: this.repoId }).exec(),
      this.removeCache(),
    ]);
    logger.info("reset", { repoId: this._model.repoId });
  }

  /**
   * Remove the cached files
   * @returns
   */
  async removeCache() {
    // Archive cleanup is handled by the resumable recovery script. Preserve DB metadata.
    if (this.status === RepositoryStatus.ARCHIVED) return;
    await storage.rm(this.repoId);
    this.model.isReseted = true;
    this.model.sizeComputedAt = undefined;
    this.model.size = { storage: 0, file: 0 };
    if (isConnected) {
      try {
        await AnonymizedRepositoryModel.updateOne(
          { _id: this._model._id },
          { $set: { isReseted: true, size: this._model.size }, $unset: { sizeComputedAt: "" } }
        ).exec();
      } catch (error) {
        logger.error("removeCache save failed", serializeError(error));
      }
    }
  }

  /**
   * Record that repository content has been cached again after a reset.
   */
  async markCachePresent() {
    if (!this.model.isReseted) return;
    this.model.isReseted = false;
    if (isConnected) {
      await AnonymizedRepositoryModel.updateOne(
        { _id: this._model._id },
        { $set: { isReseted: false } }
      ).exec();
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
    if (this.status !== RepositoryStatus.READY)
      return { storage: 0, file: 0 };
    if (this._model.size.file || this._model.sizeComputedAt) return this._model.size;
    const res = await FileModel.aggregate([
      {
        $match: {
          repoId: this.repoId,
          treeGeneration: this.model.treeGeneration || { $exists: false },
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
    this._model.sizeComputedAt = new Date();
    if (isConnected) {
      await AnonymizedRepositoryModel.updateOne(
        { _id: this._model._id, treeGeneration: this.model.treeGeneration || { $exists: false },
          fileMetadataRevision: this.model.fileMetadataRevision || { $exists: false } },
        { $set: { size: this._model.size, sizeComputedAt: this._model.sizeComputedAt } }
      ).exec();
    }
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

  get coauthors() {
    return this._model.coauthors || [];
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
      coauthors: (this._model.coauthors || []).map((c) => ({
        username: c.username,
        githubId: c.githubId,
        photo: c.photo,
      })),
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
