import AnonymizedFile from "../AnonymizedFile";
import GitHubBase from "./GitHubBase";
import storage from "../storage";
import { SourceBase, Tree } from "../types";
import * as path from "path";
import got from "got";

import * as stream from "stream";
import AnonymousError from "../AnonymousError";
import config from "../../config";
import { trace } from "@opentelemetry/api";
import { FILE_TYPE } from "../storage/Storage";

export default class GitHubStream extends GitHubBase implements SourceBase {
  type: "GitHubDownload" | "GitHubStream" | "Zip" = "GitHubStream";

  constructor(data: {
    branch?: string;
    commit?: string;
    repositoryId?: string;
    repositoryName?: string;
    accessToken?: string;
  }) {
    super(data);
  }

  downloadFile(sha: string, token: string) {
    const span = trace.getTracer("ano-file").startSpan("GHStream.downloadFile");
    span.setAttribute("sha", sha);
    const octokit = GitHubBase.octokit(token);
    try {
      const { url } = octokit.rest.git.getBlob.endpoint({
        owner: this.githubRepository.owner,
        repo: this.githubRepository.repo,
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
        object: this.githubRepository,
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
      try {
        const token = await this.getToken(file.repository.owner.id);
        const content = this.downloadFile(file_sha, token);

        // duplicate the stream to write it to the storage
        const stream1 = content.pipe(new stream.PassThrough());
        const stream2 = content.pipe(new stream.PassThrough());
        storage.write(
          file.repository.repoId,
          file.filePath,
          stream1,
          file,
          this
        );
        return stream2;
      } catch (error) {
        if (
          (error as any).status === 404 ||
          (error as any).httpStatus === 404
        ) {
          throw new AnonymousError("file_not_found", {
            httpStatus: (error as any).status || (error as any).httpStatus,
            cause: error as Error,
            object: file,
          });
        }
        throw new AnonymousError("file_too_big", {
          httpStatus: (error as any).status || (error as any).httpStatus,
          cause: error as Error,
          object: file,
        });
      }
    } finally {
      span.end();
    }
  }

  async getFiles() {
    const span = trace.getTracer("ano-file").startSpan("GHStream.getFiles");
    span.setAttribute("repoName", this.githubRepository.fullName || "");
    try {
      let commit = this.branch?.commit;
      return this.getTree(await this.getToken(), commit);
    } finally {
      span.end();
    }
  }

  private async getTree(
    token: string,
    sha: string,
    truncatedTree: Tree = {},
    parentPath: string = "",
    count = {
      file: 0,
      request: 0,
    }
  ) {
    const span = trace.getTracer("ano-file").startSpan("GHStream.getTree");
    span.setAttribute("repoName", this.githubRepository.fullName || "");
    span.setAttribute("sha", sha);

    let ghRes: Awaited<ReturnType<typeof this.getGHTree>>;
    try {
      count.request++;
      ghRes = await this.getGHTree(token, sha, { recursive: true });
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
            owner: this.githubRepository.owner,
            repo: this.githubRepository.repo,
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
      await this.getTruncatedTree(token, sha, tree, parentPath, count);
    }
    span.end();
    return tree;
  }

  private async getGHTree(
    token: string,
    sha: string,
    opt = { recursive: true }
  ) {
    const span = trace.getTracer("ano-file").startSpan("GHStream.getGHTree");
    span.setAttribute("sha", sha);
    try {
      const octokit = GitHubBase.octokit(token);
      const ghRes = await octokit.git.getTree({
        owner: this.githubRepository.owner,
        repo: this.githubRepository.repo,
        tree_sha: sha,
        recursive: opt.recursive ? "1" : undefined,
      });
      return ghRes.data;
    } finally {
      span.end();
    }
  }

  private async getTruncatedTree(
    token: string,
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
        data = await this.getGHTree(token, sha, { recursive: false });
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
                token,
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
          const data = await this.getGHTree(token, sha, { recursive: true });
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
