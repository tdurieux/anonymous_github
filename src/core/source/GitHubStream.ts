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
import { FILE_TYPE } from "../storage/Storage";
import { octokit, waitForTokenGate } from "../GitHubUtils";
import FileModel from "../model/files/files.model";
import { IFile } from "../model/files/files.types";
import { createLogger, serializeError } from "../logger";
import config from "../../config";


const logger = createLogger("gh-stream");

const GH_API_CONCURRENCY = 6;

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
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
          accept: "application/vnd.github.raw+json",
          authorization: `token ${token}`,
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

  // GitHub's web raw URL auto-resolves Git LFS pointers via redirect to
  // media.githubusercontent.com, with the auth header carried through. The
  // blob endpoint above returns the raw pointer text instead, so we use this
  // as the fallback for LFS files (#95).
  private downloadFileViaRaw(token: string, filePath: string) {
    const url = githubRawFileUrl(
      this.data.organization,
      this.data.repoName,
      this.data.commit,
      filePath
    );
    logger.debug("downloading via raw URL (LFS)", { url });
    return got.stream(url, {
      headers: { authorization: `token ${token}` },
      followRedirect: true,
    });
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
    return new Promise<stream.Readable>((resolve) => {
      const blobStream = this.downloadFile(token, sha);
      let settled = false;

      const fallbackStatuses = new Set([403, 404, 422]);
      const fallbackToRaw = (statusCode?: number) => {
        settled = true;
        logger.info("blob API failed, falling back to raw URL", {
          filePath,
          statusCode,
        });
        resolve(this.downloadFileViaRaw(token, filePath));
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
        // Other errors: let the normal pipeline handle them.
        // Defer destroy so callers can attach error listeners before
        // the error event fires, avoiding an uncaughtException crash.
        settled = true;
        const passthrough = new stream.PassThrough();
        resolve(passthrough);
        process.nextTick(() => passthrough.destroy(err));
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
    const out = new stream.PassThrough();
    let probe = Buffer.alloc(0);
    let decided = false;
    const PROBE_BYTES = 150;
    const LFS_PREFIX = "version https://git-lfs.github.com/spec/";

    const decide = (extra?: Buffer, sourceEnded = false) => {
      if (decided) return;
      decided = true;
      const head = probe.toString(
        "utf8",
        0,
        Math.min(probe.length, LFS_PREFIX.length)
      );
      if (head === LFS_PREFIX) {
        blobStream.destroy();
        const lfsStream = this.downloadFileViaRaw(token, filePath);
        lfsStream.on("error", (err) => out.destroy(err));
        lfsStream.pipe(out);
        return;
      }
      out.write(probe);
      if (extra && extra.length) out.write(extra);
      if (sourceEnded) {
        out.end();
        return;
      }
      blobStream.on("data", (c) => out.write(c));
      blobStream.on("end", () => out.end());
      blobStream.on("error", (err) => out.destroy(err));
    };

    blobStream.on("data", (chunk: Buffer) => {
      if (decided) return;
      const remaining = PROBE_BYTES - probe.length;
      if (chunk.length <= remaining) {
        probe = Buffer.concat([probe, chunk]);
        if (probe.length >= PROBE_BYTES) decide();
      } else {
        probe = Buffer.concat([probe, chunk.slice(0, remaining)]);
        decide(chunk.slice(remaining));
      }
    });
    blobStream.on("end", () => decide(undefined, true));
    blobStream.on("error", (err) => {
      // Always propagate — pre-decision this is the only listener; once a
      // non-LFS decision is made, the inner branch attaches its own
      // listener that will also fire, but we shouldn't rely on that being
      // there if the code is later refactored.
      decided = true;
      out.destroy(err);
    });

    return out;
  }

  async getFileContentCache(
    filePath: string,
    repoId: string,
    fileMeta: () =>
      | Promise<{ sha: string; size?: number }>
      | { sha: string; size?: number }
      | Promise<string>
      | string
  ) {
    const meta = await fileMeta();
    const expected: { sha: string; size?: number } =
      typeof meta === "string" ? { sha: meta } : meta;
    const fileInfo = await storage.exists(repoId, filePath);
    if (fileInfo == FILE_TYPE.FILE) {
      // If we know the upstream size, validate the cached entry. A cached
      // file smaller than the upstream size means a previous fetch was
      // truncated — likely a network error during the GitHub fetch left a
      // 0-byte or partial blob behind. Treat it as a miss and re-fetch.
      // Cached size >= expected is accepted: equal for normal files, and
      // larger for Git LFS files where FileModel.size is the pointer's
      // size but the cached bytes are the resolved LFS content.
      if (expected.size != null && expected.size > 0) {
        try {
          const stat = await storage.fileInfo(repoId, filePath);
          if (stat.size != null && stat.size < expected.size) {
            await storage.rm(repoId, filePath);
          } else {
            return storage.read(repoId, filePath);
          }
        } catch {
          // fall through and re-fetch
        }
      } else {
        return storage.read(repoId, filePath);
      }
    } else if (fileInfo == FILE_TYPE.FOLDER) {
      throw new AnonymousError("folder_not_supported", {
        httpStatus: 400,
        object: filePath,
      });
    }

    // GitHub's blob API rejects blobs larger than 100 MB with HTTP 422.
    // Skip the download entirely when the tree already tells us the file is
    // over the cap, so we surface a clean `file_too_big` instead of paying
    // the round-trip just to translate a 422.
    if (expected.size != null && expected.size > config.MAX_FILE_SIZE) {
      throw new AnonymousError("file_too_big", {
        httpStatus: 413,
        object: filePath,
      });
    }
    const token = await this.data.getToken();

    // Try the blob API first, but fall back to the raw URL on recoverable
    // blob misses/caps while still preserving LFS pointer handling.
    const content = await this.downloadWithFallback(
      token,
      expected.sha,
      filePath
    );

    // duplicate the stream to write it to the storage
    const stream1 = content.pipe(new stream.PassThrough());
    const stream2 = content.pipe(new stream.PassThrough());

    // Safety net: guarantee an `error` listener exists on both branches
    // before any error can be emitted. storage.write attaches its listener
    // only after an `await mk(...)`, and the route handler attaches its
    // listener after awaiting this function — both leave a window where
    // an upstream error would have no listener and escalate to
    // uncaughtException, crashing the streamer.
    const noop = () => {};
    stream1.on("error", noop);
    stream2.on("error", noop);

    content.on("error", (error) => {
      const httpStatus =
        (error as { response?: { statusCode?: number } })?.response
          ?.statusCode ??
        (error as { status?: number })?.status ??
        (error as { httpStatus?: number })?.httpStatus;
      const errCode = (error as { code?: string })?.code;
      const isTransient =
        !httpStatus &&
        (errCode === "ECONNRESET" ||
          errCode === "ETIMEDOUT" ||
          errCode === "ERR_BODY_PARSE_FAILURE" ||
          error.name === "ReadError");
      const code =
        httpStatus === 422
          ? "file_too_big"
          : httpStatus === 403
          ? "file_not_accessible"
          : isTransient
          ? "upstream_error"
          : "file_not_found";
      const wrapped = new AnonymousError(code, {
        httpStatus: isTransient ? 502 : httpStatus,
        cause: error as Error,
        object: filePath,
      });
      stream1.destroy(wrapped);
      stream2.destroy(wrapped);
    });

    // Fire-and-forget: storage.write logs its own failures inside FileSystem
    // (`[fs] write failed`). Swallow the rejection here so an upstream error
    // (e.g. GitHub 422 on a too-big blob) doesn't surface as an unhandled
    // promise rejection and crash the streamer process.
    storage
      .write(repoId, filePath, stream1, this.type, expected.size)
      .catch(() => {});
    return stream2;
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
        return { sha: fileSha, size: await file.size() };
      }
    );
  }

  async getFiles(progress?: (status: string) => void) {
    this._truncatedFolders = [];
    return this.getTruncatedTree(this.data.commit, progress);
  }

  /**
   * Fetch a single file's blob metadata directly from GitHub. Used as a
   * fallback when the stored tree is incomplete because GitHub truncated
   * the tree listing of a very large repository (#738). The `object` media
   * type returns sha/size without the content payload, so it also works for
   * files above the 1MB contents-API inline limit.
   */
  async fetchFileInfoFromPath(filePath: string): Promise<IFile | null> {
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
      logger.debug("fetchFileInfoFromPath miss", {
        filePath,
        error: serializeError(error),
      });
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
    await waitForTokenGate(token);
    const ghRes = await oct.git.getTree({
      owner: this.data.organization,
      repo: this.data.repoName,
      tree_sha: sha,
      recursive: opt.recursive === true ? "1" : undefined,
    });
    count.request++;
    count.file += ghRes.data.tree.length;
    if (opt.callback) {
      opt.callback();
    }
    return ghRes.data;
  }

  private async getTruncatedTree(
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
    const output: IFile[] = [];
    let data;
    try {
      data = await this.getGHTree(oct, token, sha, count, {
        recursive: false,
        callback: () => {
          if (progress) {
            progress("List file: " + count.file);
          }
        },
      });
      if (data.truncated) {
        this._truncatedFolders.push(parentPath);
      }
      output.push(...this.tree2Tree(data.tree, parentPath));
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 409) {
        logger.debug("getTree empty repo", serializeError(error));
        throw new AnonymousError("repo_empty", {
          httpStatus: 409,
          object: this.data,
          cause: error as Error,
        });
      }
      if (status === 404) {
        logger.debug("getTree miss", serializeError(error));
        const code = await classifyGitHubMissError(error, this.data);
        throw new AnonymousError(code, {
          httpStatus: 404,
          object: this.data,
          cause: error as Error,
        });
      }
      logger.warn("getTree failed", serializeError(error));
      throw new AnonymousError("repo_not_found", {
        httpStatus: status || 404,
        object: this.data,
        cause: error as Error,
      });
    }
    const subtrees: { sha: string; parentPath: string }[] = [];
    for (const file of data.tree) {
      if (file.type == "tree" && file.path && file.sha) {
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
        output.push(...result.files);
        queue.push(...result.children);
      }
    }
    return output;
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
      return new FileModel({
        name: basename(fullPath),
        path: pathFile,
        repoId: this.data.repoId,
        size: elem.size,
        sha: elem.sha,
      });
    });
  }
}
