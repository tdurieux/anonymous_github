import { Octokit } from "@octokit/rest";
import AnonymizedFile from "../AnonymizedFile";
import Repository from "../Repository";
import GitHubBase from "./GitHubBase";
import storage from "../storage";
import { RepositoryStatus, SourceBase, Tree } from "../types";
import * as path from "path";

import * as stream from "stream";
import AnonymousError from "../AnonymousError";
import config from "../../config";

export default class GitHubStream extends GitHubBase implements SourceBase {
  constructor(
    data: {
      type: "GitHubDownload" | "GitHubStream" | "Zip";
      branch?: string;
      commit?: string;
      repositoryId?: string;
      repositoryName?: string;
      accessToken?: string;
    },
    repository: Repository
  ) {
    super(data, repository);
  }

  async getFileContent(file: AnonymizedFile): Promise<stream.Readable> {
    const octokit = new Octokit({
      auth: await this.getToken(),
    });

    const file_sha = await file.sha();
    if (!file_sha) {
      throw new AnonymousError("file_not_accessible", {
        httpStatus: 404,
        object: file,
      });
    }
    try {
      const ghRes = await octokit.rest.git.getBlob({
        owner: this.githubRepository.owner,
        repo: this.githubRepository.repo,
        file_sha,
      });
      if (!ghRes.data.content && ghRes.data.size != 0) {
        throw new AnonymousError("file_not_accessible", {
          httpStatus: 404,
          object: file,
        });
      }
      // empty file
      let content: Buffer;
      if (ghRes.data.content) {
        content = Buffer.from(
          ghRes.data.content,
          ghRes.data.encoding as BufferEncoding
        );
      } else {
        content = Buffer.from("");
      }
      await storage.write(file.originalCachePath, content, file, this);
      this.repository.model.isReseted = false;
      await this.repository.model.save();
      if (this.repository.status !== RepositoryStatus.READY)
        await this.repository.updateStatus(RepositoryStatus.READY);
      return stream.Readable.from(content);
    } catch (error) {
      if ((error as any).status === 404 || (error as any).httpStatus === 404) {
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
  }

  async getFiles() {
    let commit = this.branch?.commit;
    if (!commit && this.repository.model.source.commit) {
      commit = this.repository.model.source.commit;
    }
    return this.getTree(commit);
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
    this.repository.model.truckedFileList = false;

    let ghRes: Awaited<ReturnType<typeof this.getGHTree>>;
    try {
      count.request++;
      ghRes = await this.getGHTree(sha, { recursive: true });
    } catch (error) {
      if ((error as any).status == 409) {
        // empty tree
        if (this.repository.status != RepositoryStatus.READY)
          await this.repository.updateStatus(RepositoryStatus.READY);
        // cannot be empty otherwise it would try to download it again
        return { __: {} };
      } else {
        console.log(
          `[ERROR] getTree ${this.repository.repoId}@${sha}: ${
            (error as Error).message
          }`
        );
        await this.repository.resetSate(
          RepositoryStatus.ERROR,
          "repo_not_accessible"
        );
        throw new AnonymousError("repo_not_accessible", {
          httpStatus: (error as any).status,
          cause: error as Error,
          object: {
            owner: this.githubRepository.owner,
            repo: this.githubRepository.repo,
            tree_sha: sha,
          },
        });
      }
    }
    const tree = this.tree2Tree(ghRes.tree, truncatedTree, parentPath);
    count.file += ghRes.tree.length;
    if (ghRes.truncated) {
      await this.getTruncatedTree(sha, tree, parentPath, count);
    }
    if (this.repository.status !== RepositoryStatus.READY)
      await this.repository.updateStatus(RepositoryStatus.READY);
    return tree;
  }

  private async getGHTree(sha: string, opt = { recursive: true }) {
    const octokit = new Octokit({
      auth: await this.getToken(),
    });
    const ghRes = await octokit.git.getTree({
      owner: this.githubRepository.owner,
      repo: this.githubRepository.repo,
      tree_sha: sha,
      recursive: opt.recursive ? "1" : undefined,
    });
    return ghRes.data;
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
    console.log(
      `sha ${sha}, countFiles: ${count.file} countRequest: ${count.request}, parentPath: "${parentPath}"`
    );
    count.request++;
    const data = await this.getGHTree(sha, { recursive: false });
    this.tree2Tree(data.tree, truncatedTree, parentPath);

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
      const data = await this.getGHTree(sha, { recursive: true });
      this.tree2Tree(data.tree, truncatedTree, parentPath);
      if (data.truncated) {
        this.repository.model.truckedFileList = true;
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
    partialTree: Tree = {},
    parentPath: string = ""
  ) {
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
          this.repository.model.truckedFileList = true;
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
  }
}
