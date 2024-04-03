import AnonymizedFile from "../AnonymizedFile";
import GitHubBase, { GitHubBaseData } from "./GitHubBase";
import storage from "../storage";
import { Tree } from "../types";
import * as path from "path";
import got from "got";

import * as stream from "stream";
import AnonymousError from "../AnonymousError";
import config from "../../config";
import { trace } from "@opentelemetry/api";
import { FILE_TYPE } from "../storage/Storage";
import { octokit } from "../GitHubUtils";

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
      const fileInfo = await storage.exists(
        file.repository.repoId,
        file.filePath
      );
      if (fileInfo == FILE_TYPE.FILE) {
        return storage.read(file.repository.repoId, file.filePath);
      } else if (fileInfo == FILE_TYPE.FOLDER) {
        throw new AnonymousError("folder_not_supported", {
          httpStatus: 400,
          object: file,
        });
      }
      span.setAttribute("path", file.filePath);
      const file_sha = await file.sha();
      if (!file_sha) {
        throw new AnonymousError("file_not_accessible", {
          httpStatus: 404,
          object: file,
        });
      }
      const content = this.downloadFile(await this.data.getToken(), file_sha);

      // duplicate the stream to write it to the storage
      const stream1 = content.pipe(new stream.PassThrough());
      const stream2 = content.pipe(new stream.PassThrough());

      content.on("error", (error) => {
        error = new AnonymousError("file_not_found", {
          httpStatus: (error as any).status || (error as any).httpStatus,
          cause: error as Error,
          object: file,
        });
        stream1.emit("error", error);
        stream2.emit("error", error);
      });

      storage.write(file.repository.repoId, file.filePath, stream1, this.type);
      return stream2;
    } finally {
      span.end();
    }
  }

  async getFiles() {
    const span = trace.getTracer("ano-file").startSpan("GHStream.getFiles");
    span.setAttribute("repoId", this.data.repoId);
    try {
      return this.getTree(this.data.commit);
    } finally {
      span.end();
    }
  }

  private async getTree(
    sha: string,
    truncatedTree: Tree = {},
    parentPath: string = "",
    count = {
      file: 0,
      request: 0,
    }
  ) {
    const span = trace.getTracer("ano-file").startSpan("GHStream.getTree");
    span.setAttribute("sha", sha);

    let ghRes: Awaited<ReturnType<typeof this.getGHTree>>;
    try {
      count.request++;
      ghRes = await this.getGHTree(sha, { recursive: true });
    } catch (error) {
      console.error(error);
      span.recordException(error as Error);
      if ((error as any).status == 409) {
        // cannot be empty otherwise it would try to download it again
        span.end();
        return { __: {} };
      } else {
        const err = new AnonymousError("repo_not_accessible", {
          httpStatus: (error as any).status,
          cause: error as Error,
          object: {
            tree_sha: sha,
          },
        });
        span.recordException(err);
        span.end();
        throw err;
      }
    }
    const tree = this.tree2Tree(ghRes.tree, truncatedTree, parentPath);
    count.file += ghRes.tree.length;
    if (ghRes.truncated) {
      await this.getTruncatedTree(sha, tree, parentPath, count);
    }
    span.end();
    return tree;
  }

  private async getGHTree(sha: string, opt = { recursive: true }) {
    const span = trace.getTracer("ano-file").startSpan("GHStream.getGHTree");
    span.setAttribute("sha", sha);
    try {
      const oct = octokit(await this.data.getToken());
      const ghRes = await oct.git.getTree({
        owner: this.data.organization,
        repo: this.data.repoName,
        tree_sha: sha,
        recursive: opt.recursive ? "1" : undefined,
      });
      return ghRes.data;
    } finally {
      span.end();
    }
  }

  private async getTruncatedTree(
    sha: string,
    truncatedTree: Tree = {},
    parentPath: string = "",
    count = {
      file: 0,
      request: 0,
    },
    depth = 0
  ) {
    const span = trace
      .getTracer("ano-file")
      .startSpan("GHStream.getTruncatedTree");
    span.setAttribute("sha", sha);
    span.setAttribute("parentPath", parentPath);
    try {
      count.request++;
      let data = null;

      try {
        data = await this.getGHTree(sha, {
          recursive: false,
        });
        this.tree2Tree(data.tree, truncatedTree, parentPath);
      } catch (error) {
        span.recordException(error as Error);
        return;
      }

      count.file += data.tree.length;
      if (data.tree.length < 100 && count.request < 200) {
        const promises: Promise<any>[] = [];
        for (const file of data.tree) {
          if (file.type == "tree" && file.path && file.sha) {
            const elementPath = path.join(parentPath, file.path);
            promises.push(
              this.getTruncatedTree(
                file.sha,
                truncatedTree,
                elementPath,
                count,
                depth + 1
              )
            );
          }
        }
        await Promise.all(promises);
      } else {
        try {
          const data = await this.getGHTree(sha, {
            recursive: true,
          });
          this.tree2Tree(data.tree, truncatedTree, parentPath);
          if (data.truncated) {
            // TODO: TRUNCATED
          }
        } catch (error) {
          span.recordException(error as Error);
        }
      }
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
    partialTree: Tree = {},
    parentPath: string = ""
  ) {
    const span = trace.getTracer("ano-file").startSpan("GHStream.tree2Tree");
    span.setAttribute("parentPath", parentPath);
    try {
      for (let elem of tree) {
        let current = partialTree;

        if (!elem.path) continue;

        const paths = path.join(parentPath, elem.path).split("/");

        // if elem is a folder iterate on all folders if it is a file stop before the filename
        const end = elem.type == "tree" ? paths.length : paths.length - 1;
        for (let i = 0; i < end; i++) {
          let p = paths[i];
          if (p[0] == "$") {
            p = "\\" + p;
          }
          if (!current[p]) {
            current[p] = {};
          }
          current = current[p] as Tree;
        }

        // if elem is a file add the file size in the file list
        if (elem.type == "blob") {
          if (Object.keys(current).length > config.MAX_FILE_FOLDER) {
            // TODO: TRUNCATED
            continue;
          }
          let p = paths[end];
          if (p[0] == "$") {
            p = "\\" + p;
          }
          current[p] = {
            size: elem.size || 0, // size in bit
            sha: elem.sha || "",
          };
        }
      }
      return partialTree;
    } finally {
      span.end();
    }
  }
}
