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

  async getFileContentCache(
    filePath: string,
    repoId: string,
    fileSha: () => Promise<string> | string
  ) {
    const fileInfo = await storage.exists(repoId, filePath);
    if (fileInfo == FILE_TYPE.FILE) {
      return storage.read(repoId, filePath);
    } else if (fileInfo == FILE_TYPE.FOLDER) {
      throw new AnonymousError("folder_not_supported", {
        httpStatus: 400,
        object: filePath,
      });
    }
    const content = this.downloadFile(
      await this.data.getToken(),
      await fileSha()
    );

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
        return fileSha;
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
