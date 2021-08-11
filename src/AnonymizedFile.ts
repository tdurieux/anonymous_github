import * as path from "path";
import * as express from "express";
import * as stream from "stream";
import Repository from "./Repository";
import { Tree, TreeFile } from "./types";
import storage from "./storage";
import config from "../config";
import { anonymizeStream } from "./anonymize-utils";

/**
 * Represent a file in a anonymized repository
 */
export default class AnonymizedFile {
  repository: Repository;
  sha?: string;
  size?: number;
  path?: string;
  anonymizedPath: string;

  constructor(
    repository: Repository,
    data: {
      path?: string;
      anonymizedPath: string;
      sha?: string;
      size?: number;
    }
  ) {
    this.repository = repository;
    if (!this.repository.options.terms) throw new Error("terms_not_specified");
    this.anonymizedPath = data.anonymizedPath;
    if (data.path) {
      this.path = data.path;
    }

    if (!data.anonymizedPath && this.path) {
      // anonymize the path
      this.anonymizedPath = this.path;
      for (let term of this.repository.options.terms) {
        if (term.trim() == "") {
          continue;
        }
        this.anonymizedPath = this.anonymizedPath.replace(
          new RegExp(term, "gi"),
          config.ANONYMIZATION_MASK
        );
      }
    }
    if (!this.sha) this.sha = data.sha;
    if (!this.size) this.size = data.size;
  }

  async send(res: express.Response): Promise<void> {
    try {
      const s = await this.anonymizedContent();
      s.on("error", (err) => {
        console.log(err);
        res.status(500).send({ error: err.message });
      });
      s.pipe(res);
    } catch (error) {
      console.log("Error during anonymization", error);
      res.status(500).send({ error: error.message });
    }
  }

  async isFileSupported() {
    this.path = await this.getOriginalPath();
    const filename = path.basename(this.path);
    const extensions = filename.split(".").reverse();
    const extension = extensions[0].toLowerCase();
    if (!this.repository.options.pdf && extension == "pdf") {
      return false;
    }
    if (
      !this.repository.options.image &&
      (extension == "png" ||
        extension == "ico" ||
        extension == "jpg" ||
        extension == "jpeg" ||
        extension == "gif")
    ) {
      return false;
    }
    return true;
  }

  get originalCachePath() {
    if (!this.path) throw "path_not_defined";
    return path.join(
      this.repository.originalCachePath,
      this.path
    );
  }

  async content(): Promise<stream.Readable> {
    if (this.size && this.size > config.MAX_FILE_SIZE) {
      throw new Error("file_too_big");
    }
    if (await storage.exists(this.originalCachePath)) {
      return storage.read(this.originalCachePath);
    } else {
      return await this.repository.source?.getFileContent(this);
    }
  }

  async anonymizedContent() {
    await this.getOriginalPath();
    if (!this.path) throw new Error("path_not_specified");
    if (!this.repository.options.terms) throw new Error("terms_not_specified");
    const rs = await this.content();
    const contentStream = rs.pipe(anonymizeStream(this.path, this.repository));
    return contentStream;
  }

  /**
   * De-anonymize the path
   * 
   * @returns the origin relative path of the file
   */
  async getOriginalPath(): Promise<string> {
    if (!this.anonymizedPath) throw new Error("path_not_specified");

    const files = await this.repository.files();
    const paths = this.anonymizedPath.trim().split("/");

    let current: any = await this.repository.anonymizedFiles();
    for (let i = 0; i < paths.length; i++) {
      const fileName = paths[i];
      if (fileName == "") {
        continue;
      }
      if (current[fileName]) {
        current = current[fileName];
      } else {
        throw new Error("file_not_found");
      }
    }

    function tree2sha(
      tree: any,
      output: { [key: string]: string } = {},
      parent: string = ""
    ): { [key: string]: string } {
      for (let i in tree) {
        const sha = tree[i].sha as string;
        const size = tree[i].size as number;
        if (sha != null && size != null) {
          output[sha] = path.join(parent, i);
        } else if (tree[i].child) {
          tree2sha(tree[i].child as Tree, output, path.join(parent, i));
        } else {
          tree2sha(tree[i] as Tree, output, path.join(parent, i));
        }
      }
      return output;
    }

    const shaTree = tree2sha(files);
    if (!current.sha || !shaTree[current.sha]) {
      throw new Error("file_not_found");
    }
    this.path = shaTree[current.sha];
    this.sha = current.sha;
    if ((current as TreeFile).size) this.size = (current as TreeFile).size;
    return this.path;
  }
}
