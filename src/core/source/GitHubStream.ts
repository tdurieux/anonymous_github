import AnonymizedFile from "../AnonymizedFile";
import GitHubBase, { GitHubBaseData } from "./GitHubBase";
import storage from "../storage";
import * as path from "path";
import got from "got";
import { basename, dirname } from "path";

import * as stream from "stream";
import AnonymousError from "../AnonymousError";
import { FILE_TYPE } from "../storage/Storage";
import { octokit } from "../GitHubUtils";
import FileModel from "../model/files/files.model";
import { IFile } from "../model/files/files.types";

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
      console.log("[GHStream] Downloading file", url);
      return got.stream(url, {
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
          accept: "application/vnd.github.raw+json",
          authorization: `token ${token}`,
        },
      });
    } catch (error) {
      console.error(error);
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
    const url = `https://github.com/${this.data.organization}/${this.data.repoName}/raw/${this.data.commit}/${filePath}`;
    console.log("[GHStream] Downloading via raw URL (LFS)", url);
    return got.stream(url, {
      headers: { authorization: `token ${token}` },
      followRedirect: true,
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

    const decide = (extra?: Buffer) => {
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
      } else {
        out.write(probe);
        if (extra && extra.length) out.write(extra);
        blobStream.on("data", (c) => out.write(c));
        blobStream.on("end", () => out.end());
        blobStream.on("error", (err) => out.destroy(err));
      }
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
    blobStream.on("end", () => decide());
    blobStream.on("error", (err) => {
      if (decided) return;
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
    const token = await this.data.getToken();
    const blobStream = this.downloadFile(token, expected.sha);
    // If the blob is a Git LFS pointer, swap to a raw-URL fetch so the
    // file content (not the pointer text) makes it into the pipeline. See
    // #95 — Support for Git LFS.
    const content = this.resolveLfsPointer(blobStream, token, filePath);

    // duplicate the stream to write it to the storage
    const stream1 = content.pipe(new stream.PassThrough());
    const stream2 = content.pipe(new stream.PassThrough());

    content.on("error", (error) => {
      error = new AnonymousError("file_not_found", {
        httpStatus: (error as { status?: number; httpStatus?: number }).status || (error as { httpStatus?: number }).httpStatus,
        cause: error as Error,
        object: filePath,
      });
      stream1.emit("error", error);
      stream2.emit("error", error);
    });

    storage.write(repoId, filePath, stream1, this.type);
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

  private async getGHTree(
    sha: string,
    count = { request: 0, file: 0 },
    opt = { recursive: true, callback: () => {} }
  ) {
    const oct = octokit(await this.data.getToken());
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
    const count = {
      request: 0,
      file: 0,
    };
    const output: IFile[] = [];
    let data;
    try {
      data = await this.getGHTree(sha, count, {
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
      console.log(error);
      const status = (error as { status?: number }).status;
      if (status === 409) {
        throw new AnonymousError("repo_empty", {
          httpStatus: 409,
          object: this.data,
          cause: error as Error,
        });
      }
      if (status === 404) {
        throw new AnonymousError("repo_not_found", {
          httpStatus: 404,
          object: this.data,
          cause: error as Error,
        });
      }
      throw new AnonymousError("repo_not_found", {
        httpStatus: status || 500,
        object: this.data,
        cause: error as Error,
      });
    }
    const promises: ReturnType<GitHubStream["getGHTree"]>[] = [];
    const parentPaths: string[] = [];
    for (const file of data.tree) {
      if (file.type == "tree" && file.path && file.sha) {
        const elementPath = path.join(parentPath, file.path);
        parentPaths.push(elementPath);
        promises.push(
          this.getGHTree(file.sha, count, {
            recursive: true,
            callback: () => {
              if (progress) {
                progress("List file: " + count.file);
              }
            },
          })
        );
      }
    }
    (await Promise.all(promises)).forEach((data, i) => {
      if (data.truncated) {
        this._truncatedFolders.push(parentPaths[i]);
      }
      output.push(...this.tree2Tree(data.tree, parentPaths[i]));
    });
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
