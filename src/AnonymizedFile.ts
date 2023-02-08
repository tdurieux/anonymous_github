import { join, basename } from "path";
import { Response } from "express";
import { Readable } from "stream";
import Repository from "./Repository";
import { TreeElement, TreeFile } from "./types";
import storage from "./storage";
import config from "../config";
import { anonymizePath, anonymizeStream } from "./anonymize-utils";
import AnonymousError from "./AnonymousError";
import { handleError } from "./routes/route-utils";

/**
 * Represent a file in a anonymized repository
 */
export default class AnonymizedFile {
  private _originalPath: string;
  private fileSize?: number;

  repository: Repository;
  anonymizedPath: string;
  _sha?: string;

  constructor(data: { repository: Repository; anonymizedPath: string }) {
    this.repository = data.repository;
    if (!this.repository.options.terms)
      throw new AnonymousError("terms_not_specified", {
        object: this,
        httpStatus: 400,
      });
    this.anonymizedPath = data.anonymizedPath;
  }

  async sha() {
    if (this._sha) return this._sha;
    await this.originalPath();
    return this._sha;
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
    let currentOriginal = (await this.repository.files({
      force: false,
    })) as TreeElement;
    let currentOriginalPath = "";
    for (let i = 0; i < paths.length; i++) {
      const fileName = paths[i];
      if (fileName == "") {
        continue;
      }
      if (!currentOriginal[fileName]) {
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
        } else if (options.length == 0) {
          throw new AnonymousError("file_not_found", {
            object: this,
            httpStatus: 404,
          });
        } else {
          const nextName = paths[i + 1];
          if (!nextName) {
            // if there is no next name we can't find the file and we return the first option
            currentOriginalPath = join(currentOriginalPath, options[0]);
            currentOriginal = currentOriginal[options[0]];
          }
          let found = false;
          for (const option of options) {
            const optionTree = currentOriginal[option];
            if (optionTree.child) {
              const optionTreeChild = optionTree.child;
              if (optionTreeChild[nextName]) {
                currentOriginalPath = join(currentOriginalPath, option);
                currentOriginal = optionTreeChild;
                found = true;
                break;
              }
            }
          }
          if (!found) {
            // if we didn't find the next name we return the first option
            currentOriginalPath = join(currentOriginalPath, options[0]);
            currentOriginal = currentOriginal[options[0]];
          }
        }
      } else {
        currentOriginalPath = join(currentOriginalPath, fileName);
        currentOriginal = currentOriginal[fileName];
      }
    }

    if (
      currentOriginal.sha === undefined ||
      currentOriginal.size === undefined
    ) {
      throw new AnonymousError("folder_not_supported", { object: this });
    }

    const file = currentOriginal as TreeFile;
    this.fileSize = file.size;
    this._sha = file.sha;

    this._originalPath = currentOriginalPath;
    return this._originalPath;
  }
  extension() {
    const filename = basename(this.anonymizedPath);
    const extensions = filename.split(".").reverse();
    return extensions[0].toLowerCase();
  }
  isImage() {
    const extension = this.extension();
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
  isFileSupported() {
    const extension = this.extension();
    if (!this.repository.options.pdf && extension == "pdf") {
      return false;
    }
    if (!this.repository.options.image && this.isImage()) {
      return false;
    }
    return true;
  }

  async content(): Promise<Readable> {
    if (this.anonymizedPath.includes(config.ANONYMIZATION_MASK)) {
      await this.originalPath();
    }
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
    return (await this.content()).pipe(anonymizeStream(this));
  }

  get originalCachePath() {
    if (!this.originalPath)
      throw new AnonymousError("path_not_defined", {
        object: this,
        httpStatus: 400,
      });
    if (!this._originalPath) {
      if (this.anonymizedPath.includes(config.ANONYMIZATION_MASK)) {
        throw new AnonymousError("path_not_defined", {
          object: this,
          httpStatus: 400,
        });
      } else {
        return join(this.repository.originalCachePath, this.anonymizedPath);
      }
    }

    return join(this.repository.originalCachePath, this._originalPath);
  }

  async send(res: Response): Promise<void> {
    if (this.extension()) {
      res.contentType(this.extension());
    }
    if (this.fileSize) {
      res.set("Content-Length", this.fileSize.toString());
    }
    return new Promise(async (resolve, reject) => {
      try {
        (await this.anonymizedContent())
          .pipe(res)
          .on("close", () => resolve())
          .on("error", (error) => {
            reject(error);
            handleError(error, res);
          });
      } catch (error) {
        handleError(error, res);
      }
    });
  }
}
