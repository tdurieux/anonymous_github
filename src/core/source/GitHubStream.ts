import { reserveFileExpansion } from "../billing/quotas";
import { withOwnerAccessRecovery } from "../owner-notifications";
import { ExpiringMap } from "../expiring-map";
import { sharedBlobCache, CacheAdmissionError, BlobProof } from "../blob-cache";
import { observeCache } from "../cache-observability";
import { contentGenerationPrefix, contentRetirementMarker } from "../content-generation";
import { createHash } from "crypto";
import { coordinatedFill } from "../cache-coordination";
import { githubTokenContext } from "../github-token-context";
import AnonymizedFile from "../AnonymizedFile";
import GitHubBase, {
  GitHubBaseData,
  classifyGitHubMissError,
} from "./GitHubBase";
import storage from "../storage";
import * as path from "path";
import got from "got";
import { basename, dirname } from "path";

import * as stream from "stream";
import AnonymousError from "../AnonymousError";
import { octokit, waitForTokenGate, RateLimitDelayError } from "../GitHubUtils";
import { expandSubmodules, validUpstream, MAX_SUBMODULE_ENTRIES } from "./github-submodules";
import { IFile, UpstreamFile } from "../model/files/files.types";
import { createLogger, serializeError } from "../logger";
import { measureStage, recordCacheHit } from "../request-monitoring";
import config from "../../config";
import { isConnected } from "../../server/database";
import AnonymizedRepositoryModel from "../model/anonymizedRepositories/anonymizedRepositories.model";
import { RepositoryStatus } from "../types";
import { cachedContentMiss, classifyContentMiss } from "./github-content-miss";


const logger = createLogger("gh-stream");

const GH_API_CONCURRENCY = 6;
const MAX_PENDING_TREE_FOLDERS = 100000;
const cacheFills = new Map<string, Promise<void>>();
const missingContent = new ExpiringMap<string>(2048);

/** Stop upstream before Readable.from waits for the pending iterator to finish. */
function stopSourceOnDestroy(output: stream.Readable, stop: () => void): void {
  const destroy = output._destroy;
  output._destroy = (error, callback) => { stop(); destroy.call(output, error, callback); };
}

async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

export function githubRawFileUrl(
  owner: string,
  repo: string,
  commit: string,
  filePath: string
): string {
  const encodedPath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/raw/${encodeURIComponent(commit)}/${encodedPath}`;
}

function downloadError(error: Error, filePath: string): AnonymousError {
  if (error instanceof AnonymousError) return error;
  if (error instanceof RateLimitDelayError) return new AnonymousError("github_rate_limit_exceeded", { httpStatus: 429, cause: error });
  const response = error as Error & { response?: { statusCode?: number }; status?: number; httpStatus?: number };
  const status = response.response?.statusCode ?? response.status ?? response.httpStatus;
  const code = status === 401 || status === 403 ? "file_not_accessible"
    : status === 404 ? "file_not_found" : status === 422 ? "file_too_big" : "upstream_error";
  return new AnonymousError(code, { httpStatus: Number.isInteger(status) && status! >= 400 && status! < 500 ? status : 502, cause: error, object: filePath });
}

export default class GitHubStream extends GitHubBase {
  type: "GitHubDownload" | "GitHubStream" | "Zip" = "GitHubStream";

  private _truncatedFolders: string[] = [];

  constructor(data: GitHubBaseData) {
    super(data);
  }

  get truncatedFolderList(): string[] {
    return this._truncatedFolders;
  }

  downloadFile(token: string, sha: string) {
    const oct = octokit(token);
    try {
      const { url } = oct.rest.git.getBlob.endpoint({
        owner: this.data.organization,
        repo: this.data.repoName,
        file_sha: sha,
      });
      logger.debug("downloading file", { url });
      return got.stream(url, {
        hooks: { beforeRequest: [async () => { await githubTokenContext(token)?.renew(); }] },
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
          accept: "application/vnd.github.raw+json",
          ...(githubTokenContext(token)?.publicRepository ? {} : { authorization: `token ${token}` }),
        },
      });
    } catch (error) {
      logger.error("downloadFile failed", serializeError(error));
      throw new AnonymousError("repo_not_accessible", {
        httpStatus: 404,
        object: this.data,
        cause: error as Error,
      });
    }
  }

  // The web URL resolves public LFS pointers. Private web URLs can return
  // 404 even when the REST API can read the file, so use the scoped contents
  // API to obtain a short-lived download URL in that case.
  private downloadFileViaRaw(token: string, filePath: string) {
    const url = githubRawFileUrl(
      this.data.organization,
      this.data.repoName,
      this.data.commit || "HEAD",
      filePath
    );
    logger.debug("downloading via raw URL (LFS)", { url });
    const data = this.data;
    const cancellation = new AbortController();
    let active: stream.Readable | undefined;
    const output = stream.Readable.from((async function* () {
      try {
        active = got.stream(url, {
          hooks: { beforeRequest: [async () => { await githubTokenContext(token)?.renew(); }] },
          headers: !token || githubTokenContext(token)?.publicRepository ? {} : { authorization: `token ${token}` },
          followRedirect: true,
        });
        for await (const chunk of active) yield chunk;
        return;
      } catch (error) {
        if (!token || githubTokenContext(token)?.publicRepository ||
            (error as { response?: { statusCode?: number } }).response?.statusCode !== 404) throw error;
        await waitForTokenGate(token, cancellation.signal);
        const response = await octokit(token).repos.getContent({
          owner: data.organization, repo: data.repoName,
          path: filePath, ref: data.commit || "HEAD", mediaType: { format: "object" },
          request: { signal: cancellation.signal, timeout: 30_000 },
        }).catch(apiError => {
          if (apiError instanceof AnonymousError) throw apiError;
          const upstream = apiError as { status?: number; response?: { data?: { message?: string } } };
          if (upstream.status === 422) {
            const missingCommit = /^No commit found for SHA\b/.test(upstream.response?.data?.message || "");
            throw new AnonymousError(missingCommit ? "commit_not_found" : "upstream_error", {
              httpStatus: missingCommit ? 404 : 502, cause: apiError as Error,
            });
          }
          throw apiError;
        });
        if (cancellation.signal.aborted) return;
        const metadata = response.data as { type?: string; download_url?: string };
        if (metadata.type !== "file" || !metadata.download_url) throw error;
        const assertDownloadUrl = (value: URL) => {
          if (value.protocol !== "https:" || value.username || value.password || value.port ||
              !["raw.githubusercontent.com", "media.githubusercontent.com"].includes(value.hostname)) {
            throw new AnonymousError("upstream_error", { httpStatus: 502 });
          }
        };
        assertDownloadUrl(new URL(metadata.download_url));
        // The API URL supplies its own authorization. Never forward the
        // owner's token to the download host or a redirect destination.
        active = got.stream(metadata.download_url, {
          hooks: { beforeRedirect: [options => { assertDownloadUrl(options.url); }] },
        });
        let probe = Buffer.alloc(0);
        let checked = false;
        for await (const chunk of active) {
          if (checked) { yield chunk; continue; }
          probe = Buffer.concat([probe, Buffer.from(chunk)]);
          if (probe.length < 150) continue;
          if (probe.toString("utf8").startsWith("version https://git-lfs.github.com/spec/")) {
            throw new AnonymousError("upstream_error", { httpStatus: 502 });
          }
          checked = true; yield probe;
        }
        if (!checked && probe.length) {
          if (probe.toString("utf8").startsWith("version https://git-lfs.github.com/spec/")) {
            throw new AnonymousError("upstream_error", { httpStatus: 502 });
          }
          yield probe;
        }
      }
    })(), { objectMode: false });
    stopSourceOnDestroy(output, () => { cancellation.abort(); active?.destroy(); });
    return output;
  }

  private deferredRawDownload(token: string, filePath: string): stream.Readable {
    let active: stream.Readable | undefined;
    const download = () => this.downloadFileViaRaw(token, filePath);
    const output = stream.Readable.from((async function* () {
      active = download();
      for await (const chunk of active) yield chunk;
    })(), { objectMode: false });
    stopSourceOnDestroy(output, () => active?.destroy());
    return output;
  }

  // Try the blob API, then fall back to the raw URL on statuses where the
  // path-based endpoint can still succeed. 422 is the blob endpoint's size
  // cap; 404 can happen with stale/invalid blob SHAs while the path still
  // exists at the requested commit.
  private downloadWithFallback(
    token: string,
    sha: string,
    filePath: string
  ): Promise<stream.Readable> {
    // Public raw downloads need no bearer token and do not consume the
    // unauthenticated REST API quota. GitHub also resolves LFS pointers here.
    if (!token || githubTokenContext(token)?.publicRepository) {
      return Promise.resolve(this.deferredRawDownload(token, filePath));
    }
    return new Promise<stream.Readable>((resolve, reject) => {
      const blobStream = this.downloadFile(token, sha);
      let settled = false;

      const fallbackStatuses = new Set([403, 404, 422]);
      const fallbackToRaw = (statusCode?: number) => {
        settled = true;
        logger.info("blob API failed, falling back to raw URL", {
          filePath,
          statusCode,
        });
        resolve(this.deferredRawDownload(token, filePath));
      };

      blobStream.on("error", (err) => {
        if (settled) return;
        const statusCode = (
          err as { response?: { statusCode?: number } }
        )?.response?.statusCode;
        if (statusCode && fallbackStatuses.has(statusCode)) {
          fallbackToRaw(statusCode);
          return;
        }
        // Reject before handing a stream to the caller. nextTick runs before
        // await continuations, so emitting on a returned stream here can crash.
        settled = true;
        reject(err);
      });

      blobStream.on("response", (response) => {
        if (settled) return;
        if (fallbackStatuses.has(response.statusCode || 0)) {
          blobStream.destroy();
          fallbackToRaw(response.statusCode);
          return;
        }
        settled = true;
        resolve(this.resolveLfsPointer(blobStream, token, filePath));
      });
    });
  }

  // Wrap a blob stream so that if its first ~150 bytes look like a Git LFS
  // pointer, the bytes are dropped and replaced by a fresh fetch from the
  // raw URL endpoint (which resolves LFS automatically). Non-LFS files are
  // forwarded unchanged.
  private resolveLfsPointer(
    blobStream: stream.Readable,
    token: string,
    filePath: string
  ): stream.Readable {
    let active = blobStream;
    // The generator only reads upstream when the output has capacity.
    const downloadRaw = () => this.downloadFileViaRaw(token, filePath);
    async function* resolve() {
      let probe = Buffer.alloc(0);
      let decided = false;
      for await (const chunk of blobStream) {
        const bytes = Buffer.from(chunk);
        if (decided) {
          yield bytes;
          continue;
        }
        probe = Buffer.concat([probe, bytes]);
        if (probe.length < 150) continue;
        decided = true;
        if (probe.toString("utf8").startsWith("version https://git-lfs.github.com/spec/")) {
          active = downloadRaw();
          for await (const raw of active) yield raw;
          return;
        }
        yield probe;
        probe = Buffer.alloc(0);
      }
      if (!decided) {
        if (probe.toString("utf8").startsWith("version https://git-lfs.github.com/spec/")) {
          active = downloadRaw();
          for await (const raw of active) yield raw;
        } else if (probe.length) {
          yield probe;
        }
      }
    }
    const resolved = stream.Readable.from(resolve(), { objectMode: false });
    // Keep the generator lazy until the consumer has installed its handlers.
    stopSourceOnDestroy(resolved, () => active.destroy());
    return resolved;
  }

  async getFileContentCache(
    filePath: string,
    repoId: string,
    fileMeta: () =>
      | Promise<{ sha: string; size?: number; upstream?: UpstreamFile }>
      | { sha: string; size?: number; upstream?: UpstreamFile }
      | Promise<string>
      | string
  ) {
    const meta = await fileMeta();
    const expected: { sha: string; size?: number; upstream?: UpstreamFile } =
      typeof meta === "string" ? { sha: meta } : meta;
    if (expected.upstream && !validUpstream(expected.upstream)) throw new AnonymousError("invalid_request", { httpStatus: 400 });
    // Hydrated Mongoose subdocuments expose source fields through getters,
    // so spreading them would retain the parent's repository coordinates.
    const origin = expected.upstream ? new GitHubStream({
      ...this.data,
      organization: expected.upstream.organization,
      repoName: expected.upstream.repoName,
      commit: expected.upstream.commit,
      getToken: () => "",
    }) : this;
    const sourcePath = expected.upstream?.path || filePath;
    const generation = createHash("sha256").update(JSON.stringify([
      this.data.commit, expected.sha, this.data.cacheGeneration, this.data.cacheRevision, ...(expected.upstream ? [expected.upstream] : []),
    ])).digest("hex");
    const cachePath = this.data.cacheGeneration ? `${contentGenerationPrefix(this.data.cacheGeneration)}/${generation}/${filePath}` : filePath;
    const assertActive = async () => {
      // Retirement markers live inside the storage root and disappear when
      // expiration removes it. The persisted lifecycle also fences late fills.
      if (isConnected) {
        const current = await AnonymizedRepositoryModel.findOne({ repoId })
          .select("status treeGeneration anonymizeDate contentCacheRevision").lean().exec();
        if (!current || !current.status || [RepositoryStatus.EXPIRING, RepositoryStatus.EXPIRED,
          RepositoryStatus.REMOVING, RepositoryStatus.REMOVED, RepositoryStatus.ARCHIVED].includes(current.status)
          || (this.data.cacheGeneration && `${current.treeGeneration || "legacy"}:${current.anonymizeDate?.toISOString() || ""}` !== this.data.cacheGeneration)
          || this.data.cacheRevision !== current.contentCacheRevision) {
          throw new AnonymousError("repository_changed", { httpStatus: 409 });
        }
      }
      if (!this.data.cacheGeneration) return;
      try {
        await storage.fileInfo(repoId, contentRetirementMarker(contentGenerationPrefix(this.data.cacheGeneration)));
      } catch (error) {
        const missing = error as { code?: string; name?: string; $metadata?: { httpStatusCode?: number }; httpStatus?: number };
        if (missing.code === "ENOENT" || missing.name === "NotFound" || missing.name === "NoSuchKey" ||
          missing.$metadata?.httpStatusCode === 404 || missing.httpStatus === 404) return;
        throw error;
      }
      throw new AnonymousError("repository_changed", { httpStatus: 409 });
    };
    const key = `${repoId}:${generation}:${filePath}`;
    const cached = async () => {
      try {
        const info = await storage.fileInfo(repoId, cachePath);
        if (info.contentType === "application/x-directory") {
          throw new AnonymousError("folder_not_supported", { httpStatus: 400 });
        }
        if (expected.size != null && expected.size > 0 && (info.size == null || info.size < expected.size)) return undefined;
        return true;
      } catch (error) {
        if (error instanceof AnonymousError && error.message === "folder_not_supported") throw error;
        return undefined;
      }
    };
    const shared = sharedBlobCache();
    if (shared && /^[a-f0-9]{40}$/.test(expected.sha)) {
      await assertActive();
      if (expected.size != null && expected.size > config.MAX_FILE_SIZE) throw new AnonymousError("file_too_big", { httpStatus: 413 });
      let legacy = false, allowLegacy = true;
      let admitted = expected.size || 0;
      const expansionKey = createHash("sha256").update(filePath).digest("hex");
      const admitResolvedBytes = async (bytes: number) => {
        if (!config.BILLING_ENABLED || bytes <= admitted) return;
        const next = Math.min(config.MAX_FILE_SIZE, Math.ceil(bytes / (1024 ** 2)) * 1024 ** 2);
        await reserveFileExpansion(repoId, expansionKey, next - (expected.size || 0));
        admitted = next;
      };
      const download = async (checkMinimum = false) => {
        const parentToken = await this.data.getToken();
        const token = expected.upstream ? "" : parentToken;
        const sourceMiss = cachedContentMiss(this.data, parentToken);
        if (sourceMiss && sourceMiss !== "file_not_found") throw new AnonymousError(sourceMiss, { httpStatus: 404 });
        const missKey = createHash("sha256").update(JSON.stringify([
          key, this.data.organization, this.data.repoName, token,
        ])).digest("hex");
        const missed = missingContent.get(missKey);
        if (missed) throw new AnonymousError(missed, { httpStatus: 404 });
        const normalize = async (error: Error) => {
          const normalized = downloadError(error, filePath);
          if (expected.upstream && ["file_not_found", "file_not_accessible"].includes(normalized.message))
            return new AnonymousError("submodule_not_available", { httpStatus: 404, cause: normalized });
          if (!expected.upstream && normalized.message === "file_not_found" && normalized.httpStatus === 404) {
            const code = await classifyContentMiss(this.data, token);
            missingContent.set(missKey, code, 30_000);
            if (code !== "file_not_found") return new AnonymousError(code, { httpStatus: 404, cause: normalized });
          }
          return normalized;
        };
        const input = await origin.downloadWithFallback(token, expected.sha, sourcePath)
          .catch(async error => { throw await normalize(error); });
        input.on("error", () => {}); // The iterator below propagates normalized failures.
        const deadline = setTimeout(() => input.destroy(new AnonymousError("upstream_error", { httpStatus: 502 })), 120000);
        deadline.unref();
        const limited = stream.Readable.from((async function* () {
          let bytes = 0;
          try {
            for await (const chunk of input) {
              bytes += chunk.length;
              if (bytes > config.MAX_FILE_SIZE) throw new AnonymousError("file_too_big", { httpStatus: 413 });
              await admitResolvedBytes(bytes);
              yield chunk;
            }
            if (checkMinimum && expected.size != null && expected.size > 0 && bytes < expected.size)
              throw new AnonymousError("storage_write_size_mismatch", { httpStatus: 502 });
          } catch (error) { throw await normalize(error as Error); }
          finally { clearTimeout(deadline); input.destroy(); }
        })());
        stopSourceOnDestroy(limited, () => { clearTimeout(deadline); input.destroy(); });
        return limited;
      };
      const produce = async () => {
        if (allowLegacy && await cached()) {
          legacy = true;
          const info = await storage.fileInfo(repoId, cachePath);
          await admitResolvedBytes(info.size || 0);
          observeCache("source_legacy_promotion"); return storage.read(repoId, cachePath);
        }
        legacy = false; return download();
      };
      const verify = async (proof: BlobProof) => {
        if (proof.gitSha === expected.sha) return `git-${proof.gitSha}`;
        // Resolved LFS bytes do not hash to the Git pointer SHA. Verify both the pointer and its payload.
        const parentToken = await this.data.getToken();
        const pointer = origin.downloadFile(expected.upstream ? "" : parentToken, expected.sha);
        const timer = setTimeout(() => pointer.destroy(new Error("lfs_pointer_timeout")), 30000); timer.unref();
        let bytes = 0; const chunks: Buffer[] = [];
        try {
          for await (const chunk of pointer) { bytes += chunk.length; if (bytes > 1024) throw new Error("invalid_lfs_pointer"); chunks.push(Buffer.from(chunk)); }
          const raw = Buffer.concat(chunks), text = raw.toString("utf8");
          const sha = createHash("sha1").update(`blob ${raw.length}\0`).update(raw).digest("hex");
          if (sha !== expected.sha || !text.startsWith("version https://git-lfs.github.com/spec/v1\n") ||
            text.match(/^oid sha256:([a-f0-9]{64})$/m)?.[1] !== proof.sha256 ||
            Number(text.match(/^size (\d+)$/m)?.[1]) !== proof.size) throw new Error("invalid_blob_hash");
          return `sha256-${proof.sha256}`;
        } finally { clearTimeout(timer); pointer.destroy(); }
      };
      try {
        let content;
        try { content = await shared.getOrFill(`git-${expected.sha}`, produce, verify, expected.size); }
        catch (error) {
          if (!legacy || error instanceof CacheAdmissionError) throw error;
          allowLegacy = false;
          content = await shared.getOrFill(`git-${expected.sha}`, produce, verify, expected.size);
        }
        try {
          await assertActive();
          await admitResolvedBytes(content.cachedBlob?.record.size || 0);
        } catch (error) { content.destroy(); throw error; }
        return content;
      } catch (error) {
        if (!(error instanceof CacheAdmissionError)) throw error;
        observeCache("source_bypass"); await assertActive(); return download(true);
      }
    }
    const hit = await measureStage("cache_lookup", cached);
    recordCacheHit("source", !!hit);
    observeCache(hit ? "legacy_source_hit" : "legacy_source_miss", expected.size || 0);
    if (hit) return storage.read(repoId, cachePath);
    if (expected.size != null && expected.size > config.MAX_FILE_SIZE) {
      throw new AnonymousError("file_too_big", { httpStatus: 413, object: filePath });
    }
    let filling = cacheFills.get(key);
    if (!filling) {
      if (cacheFills.size >= 64) throw new AnonymousError("cache_busy", { httpStatus: 503 });
      filling = coordinatedFill(key, cached, async () => {
        await assertActive();
        const parentToken = await this.data.getToken();
        const token = expected.upstream ? "" : parentToken;
        const sourceMiss = cachedContentMiss(this.data, parentToken);
        if (sourceMiss && sourceMiss !== "file_not_found") throw new AnonymousError(sourceMiss, { httpStatus: 404 });
        const missKey = createHash("sha256").update(JSON.stringify([
          key, this.data.organization, this.data.repoName, token,
        ])).digest("hex");
        const missed = missingContent.get(missKey);
        if (missed) throw new AnonymousError(missed, { httpStatus: 404 });
        try {
          const fetchContent = () => measureStage("upstream", async () => {
            const content = await origin.downloadWithFallback(token, expected.sha, sourcePath)
              .catch(error => { throw downloadError(error, filePath); });
            let count = 0;
            let admitted = expected.size || 0;
            const expansionKey = createHash("sha256").update(filePath).digest("hex");
            const limited = new stream.Transform({ transform(chunk, encoding, callback) {
              count += chunk.length;
              if (count > config.MAX_FILE_SIZE) return callback(new AnonymousError("file_too_big", { httpStatus: 413 }));
              if (!config.BILLING_ENABLED || count <= admitted) return callback(null, chunk);
              // Reserve in bounded blocks to avoid a database write for every stream chunk.
              admitted = Math.min(config.MAX_FILE_SIZE, Math.ceil(count / (1024 ** 2)) * 1024 ** 2);
              reserveFileExpansion(repoId, expansionKey, admitted - (expected.size || 0))
                .then(() => callback(null, chunk), error => callback(error));
            } });
            content.on("error", error => limited.destroy(downloadError(error, filePath)));
            limited.once("close", () => content.destroy());
            limited.on("error", () => {});
            content.pipe(limited);
            const deadline = setTimeout(() => limited.destroy(new AnonymousError("upstream_error", { httpStatus: 502 })), 120_000);
            try {
              await storage.write(repoId, cachePath, limited, this.type, expected.size);
              try { await assertActive(); }
              catch (error) { await storage.rm(repoId, cachePath); throw error; }
            }
            finally { clearTimeout(deadline); limited.destroy(); content.destroy(); }
            return true;
          });
          return expected.upstream ? await fetchContent() : await this.confirmOwnerAccess(repoId, fetchContent);
        } catch (error) {
          if (expected.upstream && error instanceof AnonymousError &&
              ["file_not_found", "file_not_accessible"].includes(error.message)) {
            // A removed public dependency is not a lost parent credential.
            throw new AnonymousError("submodule_not_available", { httpStatus: 404, cause: error });
          }
          if (!expected.upstream && error instanceof AnonymousError && error.message === "file_not_found" && error.httpStatus === 404) {
            const code = await classifyContentMiss(this.data, token);
            missingContent.set(missKey, code, 30_000);
            if (code !== "file_not_found") throw new AnonymousError(code, { httpStatus: 404, cause: error });
          }
          throw error;
        }
      }).then(() => {});
      cacheFills.set(key, filling);
      void filling.finally(() => { if (cacheFills.get(key) === filling) cacheFills.delete(key); }).catch(() => {});
    }
    await measureStage("cache_fill", () => filling!);
    return storage.read(repoId, cachePath);
  }

  async getFileContent(file: AnonymizedFile): Promise<stream.Readable> {
    try {
      void file.filePath;
    } catch {
      // compute the original path if ambiguous
      await file.originalPath();
    }
    return this.getFileContentCache(
      file.filePath,
      file.repository.repoId,
      async () => {
        const fileSha = await file.sha();
        if (!fileSha) {
          throw new AnonymousError("file_not_accessible", {
            httpStatus: 404,
            object: file,
          });
        }
        return { sha: fileSha, size: await file.size(), upstream: (await file.getFileInfo()).upstream };
      }
    );
  }

  async getFiles(progress?: (status: string) => void) {
    const files: IFile[] = [];
    for await (const file of this.iterateFiles(progress)) files.push(file);
    return files;
  }

  async *iterateFiles(progress?: (status: string) => void): AsyncGenerator<IFile> {
    this._truncatedFolders = [];
    const budget = { modules: 0, remaining: MAX_SUBMODULE_ENTRIES };
    for await (const batch of this.iterateTreeBatches(this.data.commit, progress)) {
      yield* await expandSubmodules(batch, this.data, budget);
    }
  }

  /**
   * Fetch a single file's blob metadata directly from GitHub. Used as a
   * fallback when the stored tree is incomplete because GitHub truncated
   * the tree listing of a very large repository (#738). The `object` media
   * type returns sha/size without the content payload, so it also works for
   * files above the 1MB contents-API inline limit.
   */
  async fetchFileInfoFromPath(filePath: string): Promise<IFile | null> {
    return this.confirmOwnerAccess(this.data.repoId, () => this.fetchFileMetadata(filePath), result => result !== null);
  }

  private async confirmOwnerAccess<T>(repoId: string, work: () => Promise<T>, confirmed?: (result: T) => boolean): Promise<T> {
    let repository;
    try {
      repository = isConnected ? await AnonymizedRepositoryModel.findOne({ repoId })
        .select("owner source githubAccess").lean().exec() : null;
    } catch {
      // Email recovery bookkeeping must not prevent the upstream read.
      return work();
    }
    return repository?.owner ? withOwnerAccessRecovery(String(repository.owner),
      { kind: "repository", id: String(repository._id) }, work,
      { "source.repositoryName": `${this.data.organization}/${this.data.repoName}`, "source.commit": this.data.commit,
        "githubAccess.revision": repository.githubAccess?.revision ?? { $exists: false } }, confirmed) : work();
  }

  private async fetchFileMetadata(filePath: string): Promise<IFile | null> {
    if (basename(filePath) === ".gitmodules") return null;
    const token = await this.data.getToken();
    const oct = octokit(token);
    try {
      await waitForTokenGate(token);
      const res = await oct.repos.getContent({
        owner: this.data.organization,
        repo: this.data.repoName,
        path: filePath,
        ref: this.data.commit,
        mediaType: { format: "object" },
      });
      const data = res.data as { type?: string; sha?: string; size?: number };
      if (data.type !== "file" || !data.sha) return null;
      const parent = dirname(filePath);
      return {
        name: basename(filePath),
        path: parent === "." ? "" : parent,
        repoId: this.data.repoId,
        sha: data.sha,
        size: data.size,
      };
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      // A missing file and lost repository access both return 404. Only
      // report a normal miss after the repository probe remains readable.
      const code = await classifyGitHubMissError(error, this.data);
      if (code === "repo_not_found") {
        throw new AnonymousError(code, { httpStatus: 404, cause: error as Error });
      }
      return null;
    }
  }

  private async getGHTree(
    oct: ReturnType<typeof octokit>,
    token: string,
    sha: string,
    count = { request: 0, file: 0 },
    opt = { recursive: true, callback: () => {} }
  ) {
    try {
      await waitForTokenGate(token);
      const ghRes = await oct.git.getTree({
        owner: this.data.organization,
        repo: this.data.repoName,
        tree_sha: sha,
        recursive: opt.recursive === true ? "1" : undefined,
      });
      count.request++;
      count.file += ghRes.data.tree.length;
      if (opt.callback) opt.callback();
      return ghRes.data;
    } catch (error) {
      // Keep quota, credential and lifecycle errors intact. A failed tree
      // request does not imply that the repository has disappeared.
      if (error instanceof AnonymousError || error instanceof RateLimitDelayError) throw error;
      const upstream = error as { status?: number; response?: { data?: { message?: string } } };
      const status = upstream.status;
      const invalidObject = status === 422 && /^Invalid object requested\. SHA must identify a commit or a tree\b/.test(upstream.response?.data?.message || "");
      const code = status === 409 ? "repo_empty"
        : status === 404 ? await classifyGitHubMissError(error, this.data)
        : invalidObject ? "commit_not_found"
        : status === 401 ? "token_expired"
        : status === 403 ? "repo_not_accessible" : "github_unavailable";
      throw new AnonymousError(code, {
        httpStatus: status === 409 ? 409 : status === 404 || invalidObject ? 404
          : status === 401 || status === 403 ? status : 502,
        object: this.data,
        cause: error as Error,
      });
    }
  }

  private async *iterateTreeBatches(
    sha: string,
    progress?: (status: string) => void,
    parentPath: string = ""
  ) {
    const token = await this.data.getToken();
    const oct = octokit(token);
    const count = {
      request: 0,
      file: 0,
    };
    let data = await this.getGHTree(oct, token, sha, count, {
      recursive: true,
      callback: () => { progress?.("List file: " + count.file); },
    });
    if (!data.truncated) { yield this.tree2Tree(data.tree, parentPath); return; }
    data = await this.getGHTree(oct, token, sha, count, {
      recursive: false,
      callback: () => { progress?.("List file: " + count.file); },
    });
    if (data.truncated) this._truncatedFolders.push(parentPath);
    yield this.tree2Tree(data.tree, parentPath);
    const subtrees: { sha: string; parentPath: string }[] = [];
    for (const file of data.tree) {
      if (file.type == "tree" && file.path && file.sha) {
        if (subtrees.length >= MAX_PENDING_TREE_FOLDERS) {
          throw new AnonymousError("repository_tree_too_large", { httpStatus: 413 });
        }
        subtrees.push({
          sha: file.sha,
          parentPath: path.join(parentPath, file.path),
        });
      }
    }

    const queue = [...subtrees];
    while (queue.length > 0) {
      const batch = queue.splice(0, GH_API_CONCURRENCY);
      const batchResults = await pMap(
        batch,
        async (entry) => {
          const treeData = await this.getGHTree(oct, token, entry.sha, count, {
            recursive: true,
            callback: () => {
              if (progress) {
                progress("List file: " + count.file);
              }
            },
          });
          if (!treeData.truncated) {
            return { files: this.tree2Tree(treeData.tree, entry.parentPath), children: [] as typeof subtrees };
          }
          logger.info(
            `Tree truncated for ${entry.parentPath}, breaking down into subtrees`
          );
          const shallow = await this.getGHTree(oct, token, entry.sha, count, {
            recursive: false,
            callback: () => {
              if (progress) {
                progress("List file: " + count.file);
              }
            },
          });
          if (shallow.truncated) {
            this._truncatedFolders.push(entry.parentPath);
          }
          const children = shallow.tree
            .filter(
              (f): f is typeof f & { sha: string; path: string } =>
                f.type === "tree" && !!f.path && !!f.sha
            )
            .map((f) => ({
              sha: f.sha,
              parentPath: path.join(entry.parentPath, f.path),
            }));
          return { files: this.tree2Tree(shallow.tree, entry.parentPath), children };
        },
        GH_API_CONCURRENCY
      );
      for (const result of batchResults) {
        yield result.files;
        for (const child of result.children) {
          if (queue.length >= MAX_PENDING_TREE_FOLDERS) {
            throw new AnonymousError("repository_tree_too_large", { httpStatus: 413 });
          }
          queue.push(child);
        }
      }
    }
  }

  private tree2Tree(
    tree: {
      path?: string;
      mode?: string;
      type?: string;
      sha?: string;
      size?: number;
      url?: string;
    }[],
    parentPath: string = ""
  ) {
    return tree.map((elem) => {
      const fullPath = path.join(parentPath, elem.path || "");
      let pathFile = dirname(fullPath);
      if (pathFile === ".") {
        pathFile = "";
      }
      return {
        name: basename(fullPath),
        path: pathFile,
        repoId: this.data.repoId,
        size: elem.size,
        ...(elem.type === "commit" ? { submodule: "unsupported" as const } : {}),
        sha: elem.sha,
      };
    });
  }
}
