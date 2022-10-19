import { Octokit } from "@octokit/rest";
import AnonymizedFile from "../AnonymizedFile";
import Repository from "../Repository";
import GitHubBase from "./GitHubBase";
import storage from "../storage";
import { SourceBase, Tree } from "../types";
import * as path from "path";

import * as stream from "stream";
import AnonymousError from "../AnonymousError";

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
    if (!file.sha)
      throw new AnonymousError("file_sha_not_provided", {
        httpStatus: 400,
        object: file,
      });
    const octokit = new Octokit({
      auth: await this.getToken(),
    });

    try {
      const ghRes = await octokit.rest.git.getBlob({
        owner: this.githubRepository.owner,
        repo: this.githubRepository.repo,
        file_sha: file.sha,
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
      if (this.repository.status != "ready")
        await this.repository.updateStatus("ready");
      await storage.write(file.originalCachePath, content, file, this);
      return stream.Readable.from(content);
    } catch (error) {
      if (error.status == 404) {
        throw new AnonymousError("file_not_found", {
          httpStatus: error.status,
          cause: error,
          object: file,
        });
      }
      throw new AnonymousError("file_too_big", {
        httpStatus: error.status,
        cause: error,
        object: file,
      });
    }
  }

  async getFiles() {
    return this.getTree(this.branch.commit);
  }

  private async getTree(
    sha: string,
    truncatedTree: Tree = {},
    parentPath: string = ""
  ) {
    const octokit = new Octokit({
      auth: await this.getToken(),
    });

    let ghRes;

    try {
      ghRes = await octokit.git.getTree({
        owner: this.githubRepository.owner,
        repo: this.githubRepository.repo,
        tree_sha: sha,
        recursive: "1",
      });
    } catch (error) {
      if (error.status == 409) {
        // empty tree
        if (this.repository.status != "ready")
          await this.repository.updateStatus("ready");
        // cannot be empty otherwise it would try to download it again
        return { __: {} };
      } else {
        await this.repository.resetSate("error", "repo_not_accessible");
        throw new AnonymousError("repo_not_accessible", {
          httpStatus: error.status,
          cause: error,
          object: {
            owner: this.githubRepository.owner,
            repo: this.githubRepository.repo,
            tree_sha: sha,
          },
        });
      }
    }

    const tree = this.tree2Tree(ghRes.data.tree, truncatedTree, parentPath);
    if (ghRes.data.truncated) {
      await this.getTruncatedTree(sha, tree, parentPath);
    }
    if (this.repository.status != "ready")
      await this.repository.updateStatus("ready");
    return tree;
  }

  private async getTruncatedTree(
    sha: string,
    truncatedTree: Tree = {},
    parentPath: string = ""
  ) {
    const octokit = new Octokit({
      auth: await this.getToken(),
    });
    try {
      const ghRes = await octokit.git.getTree({
        owner: this.githubRepository.owner,
        repo: this.githubRepository.repo,
        tree_sha: sha,
      });
      const tree = ghRes.data.tree;

      for (let elem of tree) {
        if (!elem.path) continue;
        if (elem.type == "tree") {
          const elementPath = path.join(parentPath, elem.path);
          const paths = elementPath.split("/");

          let current = truncatedTree;
          for (let i = 0; i < paths.length; i++) {
            let p = paths[i];
            if (!current[p]) {
              if (elem.sha)
                await this.getTree(elem.sha, truncatedTree, elementPath);
              break;
            }
            current = current[p] as Tree;
          }
        }
      }
      this.tree2Tree(ghRes.data.tree, truncatedTree, parentPath);
      return truncatedTree;
    } catch (error) {
      if (error.status == 409) {
      }
      return truncatedTree;
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
