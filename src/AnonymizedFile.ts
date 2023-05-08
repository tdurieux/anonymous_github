import { join, basename } from "path";
import { Response } from "express";
import { Readable } from "stream";
import Repository from "./Repository";
import { FILE_TYPE, Tree, TreeElement, TreeFile } from "./types";
import storage from "./storage";
import config from "../config";
import {
  anonymizePath,
  AnonymizeTransformer,
  isTextFile,
} from "./anonymize-utils";
import AnonymousError from "./AnonymousError";
import { handleError } from "./routes/route-utils";
import { lookup } from "mime-types";

/**
 * Represent a file in a anonymized repository
 */
export default class AnonymizedFile {
  private _originalPath: string | undefined;
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
    if (this._sha) return this._sha.replace(/"/g, "");
    await this.originalPath();
    return this._sha?.replace(/"/g, "");
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
      if (!(currentOriginal as Tree)[fileName]) {
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
          currentOriginal = (currentOriginal as Tree)[options[0]];
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
            currentOriginal = (currentOriginal as Tree)[options[0]];
          }
          let found = false;
          for (const option of options) {
            const optionTree = (currentOriginal as Tree)[option];
            if ((optionTree as Tree).child) {
              const optionTreeChild = (optionTree as Tree).child;
              if ((optionTreeChild as Tree)[nextName]) {
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
            currentOriginal = (currentOriginal as Tree)[options[0]];
          }
        }
      } else {
        currentOriginalPath = join(currentOriginalPath, fileName);
        currentOriginal = (currentOriginal as Tree)[fileName];
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
    const exist = await storage.exists(this.originalCachePath);
    if (exist == FILE_TYPE.FILE) {
      return storage.read(this.originalCachePath);
    } else if (exist == FILE_TYPE.FOLDER) {
      throw new AnonymousError("folder_not_supported", {
        object: this,
        httpStatus: 400,
      });
    }
    return await this.repository.source?.getFileContent(this);
  }

  async anonymizedContent() {
    return (await this.content()).pipe(new AnonymizeTransformer(this));
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
    return new Promise(async (resolve, reject) => {
      try {
        const content = await this.content();
        const mime = lookup(this.anonymizedPath);
        if (mime && this.extension() != "ts") {
          res.contentType(mime);
        } else if (isTextFile(this.anonymizedPath)) {
          res.contentType("text/plain");
        }
        res.header("Accept-Ranges", "none");
        let fileInfo: Awaited<ReturnType<typeof storage.fileInfo>>;
        try {
          fileInfo = await storage.fileInfo(this.originalCachePath);
        } catch (error) {
          // unable to get file size
          console.error(error);
        }

        const anonymizer = new AnonymizeTransformer(this);

        anonymizer.once("transform", (data) => {
          if (data.isText && !mime) {
            res.contentType("text/plain");
          }
          if (fileInfo?.size && !data.wasAnonimized) {
            // the text files may be anonymized and therefore the size may be different
            res.header("Content-Length", fileInfo.size.toString());
          }
        });

        content
          .pipe(anonymizer)
          .pipe(res)
          .on("close", () => {
            if (!content.closed && !content.destroyed) {
              content.destroy();
            }
            resolve();
          })
          .on("error", (error) => {
            if (!content.closed && !content.destroyed) {
              content.destroy();
            }
            reject(error);
            handleError(error, res);
          });
      } catch (error) {
        handleError(error, res);
      }
    });
  }
}
