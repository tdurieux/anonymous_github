import * as path from "path";
import * as express from "express";
import * as stream from "stream";
import Repository from "./Repository";
import { Tree, TreeElement, TreeFile } from "./types";
import storage from "./storage";
import config from "../config";
import { anonymizePath, anonymizeStream } from "./anonymize-utils";
import AnonymousError from "./AnonymousError";

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

/**
 * Represent a file in a anonymized repository
 */
export default class AnonymizedFile {
  private _originalPath: string;
  private fileSize?: number;

  repository: Repository;
  anonymizedPath: string;
  sha?: string;

  constructor(data: { repository: Repository; anonymizedPath: string }) {
    this.repository = data.repository;
    if (!this.repository.options.terms)
      throw new AnonymousError("terms_not_specified");
    this.anonymizedPath = data.anonymizedPath;
  }

  /**
   * De-anonymize the path
   *
   * @returns the origin relative path of the file
   */
  async originalPath(): Promise<string> {
    if (this._originalPath) return this._originalPath;
    if (!this.anonymizedPath) throw new AnonymousError("path_not_specified");

    const paths = this.anonymizedPath.trim().split("/");

    let currentAnonymized: TreeElement = await this.repository.anonymizedFiles({
      includeSha: true,
    });
    let currentOriginal: TreeElement = await this.repository.files();
    let currentOriginalPath = "";
    let isAmbiguous = false;
    for (let i = 0; i < paths.length; i++) {
      const fileName = paths[i];
      if (fileName == "") {
        continue;
      }
      if (!currentAnonymized[fileName]) {
        throw new AnonymousError("file_not_found", this);
      }
      currentAnonymized = currentAnonymized[fileName];

      if (!isAmbiguous && !currentOriginal[fileName]) {
        // anonymize all the file in the folder and check if there is one that match the current filename
        const options = [];
        for (let originalFileName in currentOriginal) {
          if (
            anonymizePath(originalFileName, this.repository.options.terms) ==
            fileName
          ) {
            options.push(originalFileName);
          }
        }

        // if only one option we found the original filename
        if (options.length == 1) {
          currentOriginalPath = path.join(currentOriginalPath, options[0]);
          currentOriginal = currentOriginal[options[0]];
        } else {
          isAmbiguous = true;
        }
      } else if (!isAmbiguous) {
        currentOriginalPath = path.join(currentOriginalPath, fileName);
        currentOriginal = currentOriginal[fileName];
      }
    }

    if (
      currentAnonymized.sha === undefined ||
      currentAnonymized.size === undefined
    ) {
      throw new AnonymousError("folder_not_supported", this);
    }

    const file: TreeFile = currentAnonymized as TreeFile;
    this.fileSize = file.size;
    this.sha = file.sha;

    if (isAmbiguous) {
      // it should never happen
      const shaTree = tree2sha(currentOriginal);
      if (!currentAnonymized.sha || !shaTree[file.sha]) {
        throw new AnonymousError("file_not_found", this);
      }

      this._originalPath = path.join(currentOriginalPath, shaTree[file.sha]);
    } else {
      this._originalPath = currentOriginalPath;
    }

    return this._originalPath;
  }

  async isFileSupported() {
    const filename = path.basename(await this.originalPath());
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

  async content(): Promise<stream.Readable> {
    if (this.fileSize && this.fileSize > config.MAX_FILE_SIZE) {
      throw new AnonymousError("file_too_big", this);
    }
    if (await storage.exists(this.originalCachePath)) {
      return storage.read(this.originalCachePath);
    } else {
      return await this.repository.source?.getFileContent(this);
    }
  }

  async anonymizedContent() {
    await this.originalPath();
    const rs = await this.content();
    return rs.pipe(anonymizeStream(await this.originalPath(), this.repository));
  }

  get originalCachePath() {
    if (!this.originalPath) throw new AnonymousError("path_not_defined");
    return path.join(this.repository.originalCachePath, this._originalPath);
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
}
