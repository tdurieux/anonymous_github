import { join, basename } from "path";
import { Response } from "express";
import { Readable, pipeline } from "stream";
import { promisify } from "util";
import Repository from "./Repository";
import { Tree, TreeElement, TreeFile } from "./types";
import storage from "./storage";
import config from "../config";
import { anonymizePath, anonymizeStream } from "./anonymize-utils";
import AnonymousError from "./AnonymousError";
import { handleError } from "./routes/route-utils";

function tree2sha(
  tree: any,
  output: { [key: string]: string } = {},
  parent: string = ""
): { [key: string]: string } {
  for (let i in tree) {
    const sha = tree[i].sha as string;
    const size = tree[i].size as number;
    if (sha != null && size != null) {
      output[sha] = join(parent, i);
    } else if (tree[i].child) {
      tree2sha(tree[i].child as Tree, output, join(parent, i));
    } else {
      tree2sha(tree[i] as Tree, output, join(parent, i));
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
      throw new AnonymousError("terms_not_specified", {
        object: this,
        httpStatus: 400,
      });
    this.anonymizedPath = data.anonymizedPath;
  }

  /**
   * De-anonymize the path
   *
   * @returns the origin relative path of the file
   */
  async originalPath(): Promise<string> {
    if (this._originalPath) return this._originalPath;
    if (!this.anonymizedPath)
      throw new AnonymousError("path_not_specified", {
        object: this,
        httpStatus: 400,
      });

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
        throw new AnonymousError("file_not_found", {
          object: this,
          httpStatus: 404,
        });
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
          currentOriginalPath = join(currentOriginalPath, options[0]);
          currentOriginal = currentOriginal[options[0]];
        } else {
          isAmbiguous = true;
        }
      } else if (!isAmbiguous) {
        currentOriginalPath = join(currentOriginalPath, fileName);
        currentOriginal = currentOriginal[fileName];
      }
    }

    if (
      currentAnonymized.sha === undefined ||
      currentAnonymized.size === undefined
    ) {
      throw new AnonymousError("folder_not_supported", { object: this });
    }

    const file: TreeFile = currentAnonymized as TreeFile;
    this.fileSize = file.size;
    this.sha = file.sha;

    if (isAmbiguous) {
      // it should never happen
      const shaTree = tree2sha(currentOriginal);
      if (!currentAnonymized.sha || !shaTree[file.sha]) {
        throw new AnonymousError("file_not_found", {
          object: this,
          httpStatus: 404,
        });
      }

      this._originalPath = join(currentOriginalPath, shaTree[file.sha]);
    } else {
      this._originalPath = currentOriginalPath;
    }

    return this._originalPath;
  }
  async extension() {
    const filename = basename(await this.originalPath());
    const extensions = filename.split(".").reverse();
    return extensions[0].toLowerCase();
  }
  async isImage(): Promise<boolean> {
    const extension = await this.extension();
    return [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "svg",
      "ico",
      "bmp",
      "tiff",
      "tif",
      "webp",
      "avif",
      "heif",
      "heic",
    ].includes(extension);
  }
  async isFileSupported() {
    const extension = await this.extension();
    if (!this.repository.options.pdf && extension == "pdf") {
      return false;
    }
    if (!this.repository.options.image && (await this.isImage())) {
      return false;
    }
    return true;
  }

  async content(): Promise<Readable> {
    if (this.fileSize && this.fileSize > config.MAX_FILE_SIZE) {
      throw new AnonymousError("file_too_big", {
        object: this,
        httpStatus: 403,
      });
    }
    if (await storage.exists(this.originalCachePath)) {
      return storage.read(this.originalCachePath);
    }
    return await this.repository.source?.getFileContent(this);
  }

  async anonymizedContent() {
    await this.originalPath();
    const rs = await this.content();
    return rs.pipe(anonymizeStream(await this.originalPath(), this.repository));
  }

  get originalCachePath() {
    if (!this.originalPath)
      throw new AnonymousError("path_not_defined", {
        object: this,
        httpStatus: 400,
      });
    return join(this.repository.originalCachePath, this._originalPath);
  }

  async send(res: Response): Promise<void> {
    const pipe = promisify(pipeline);
    try {
      if (await this.extension()) {
        res.contentType(await this.extension());
      }
      await pipe(await this.anonymizedContent(), res);
    } catch (error) {
      handleError(error, res);
    }
  }
}
