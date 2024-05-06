import AnonymizedFile from "../AnonymizedFile";
import GitHubBase, { GitHubBaseData } from "./GitHubBase";
import storage from "../storage";
import * as path from "path";
import got from "got";
import { basename, dirname } from "path";

import * as stream from "stream";
import AnonymousError from "../AnonymousError";
import { trace } from "@opentelemetry/api";
import { FILE_TYPE } from "../storage/Storage";
import { octokit } from "../GitHubUtils";
import FileModel from "../model/files/files.model";
import { IFile } from "../model/files/files.types";

export default class GitHubStream extends GitHubBase {
  type: "GitHubDownload" | "GitHubStream" | "Zip" = "GitHubStream";

  constructor(data: GitHubBaseData) {
    super(data);
  }

  downloadFile(token: string, sha: string) {
    const span = trace.getTracer("ano-file").startSpan("GHStream.downloadFile");
    span.setAttribute("sha", sha);
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
      // span.recordException(error as Error);
      throw new AnonymousError("repo_not_accessible", {
        httpStatus: 404,
        object: this.data,
        cause: error as Error,
      });
    } finally {
      span.end();
    }
  }

  async getFileContentCache(
    filePath: string,
    repoId: string,
    fileSha: () => Promise<string> | string
  ) {
    const span = trace
      .getTracer("ano-file")
      .startSpan("GHStream.getFileContent");
    span.setAttribute("repoId", repoId);
    span.setAttribute("file", filePath);

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

    content.on("close", () => {
      span.end();
    });

    // duplicate the stream to write it to the storage
    const stream1 = content.pipe(new stream.PassThrough());
    const stream2 = content.pipe(new stream.PassThrough());

    content.on("error", (error) => {
      error = new AnonymousError("file_not_found", {
        httpStatus: (error as any).status || (error as any).httpStatus,
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
    const span = trace
      .getTracer("ano-file")
      .startSpan("GHStream.getFileContent");
    span.setAttribute("repoId", file.repository.repoId);
    span.setAttribute("file", file.anonymizedPath);
    try {
      try {
        file.filePath;
      } catch (_) {
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
    } finally {
      span.end();
    }
  }

  async getFiles(progress?: (status: string) => void) {
    const span = trace.getTracer("ano-file").startSpan("GHStream.getFiles");
    span.setAttribute("repoId", this.data.repoId);
    try {
      return this.getTruncatedTree(this.data.commit, progress);
    } finally {
      span.end();
    }
  }

  private async getGHTree(
    sha: string,
    count = { request: 0, file: 0 },
    opt = { recursive: true, callback: () => {} }
  ) {
    const span = trace.getTracer("ano-file").startSpan("GHStream.getGHTree");
    span.setAttribute("sha", sha);
    try {
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
    } finally {
      span.end();
    }
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
    const span = trace
      .getTracer("ano-file")
      .startSpan("GHStream.getTruncatedTree");
    span.setAttribute("sha", sha);
    span.setAttribute("parentPath", parentPath);
    const output: IFile[] = [];
    try {
      let data = null;
      try {
        data = await this.getGHTree(sha, count, {
          recursive: false,
          callback: () => {
            if (progress) {
              progress("List file: " + count.file);
            }
          },
        });
        output.push(...this.tree2Tree(data.tree, parentPath));
      } catch (error) {
        console.log(error);
        if ((error as any).status == 409 || (error as any).status == 404) {
          // empty repo
          data = { tree: [] };
        } else {
          throw new AnonymousError("repo_not_found", {
            httpStatus: (error as any).status || 404,
            object: this.data,
            cause: error as Error,
          });
        }
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
          // TODO: the tree is truncated
        }
        output.push(...this.tree2Tree(data.tree, parentPaths[i]));
      });
      return output;
    } finally {
      span.end();
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
    const span = trace.getTracer("ano-file").startSpan("GHStream.tree2Tree");
    span.setAttribute("parentPath", parentPath);
    try {
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
    } finally {
      span.end();
    }
  }
}
