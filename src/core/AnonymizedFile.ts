import { join, basename } from "path";
import { Response } from "express";
import { Readable } from "stream";
import { trace } from "@opentelemetry/api";
import { lookup } from "mime-types";

import Repository from "./Repository";
import { RepositoryStatus, Tree, TreeElement, TreeFile } from "./types";
import config from "../config";
import { anonymizePath, isTextFile } from "./anonymize-utils";
import AnonymousError from "./AnonymousError";
import { handleError } from "../server/routes/route-utils";
import got from "got";

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
    return trace.getTracer("ano-file").startActiveSpan("sha", async (span) => {
      try {
        span.setAttribute("anonymizedPath", this.anonymizedPath);
        if (this._sha) return this._sha.replace(/"/g, "");
        await this.originalPath();
        return this._sha?.replace(/"/g, "");
      } finally {
        span.end();
      }
    });
  }

  /**
   * De-anonymize the path
   *
   * @returns the origin relative path of the file
   */
  async originalPath(): Promise<string> {
    return trace
      .getTracer("ano-file")
      .startActiveSpan("originalPath", async (span) => {
        try {
          span.setAttribute("anonymizedPath", this.anonymizedPath);
          if (this._originalPath) return this._originalPath;
          if (!this.anonymizedPath) {
            throw new AnonymousError("path_not_specified", {
              object: this,
              httpStatus: 400,
            });
          }

          let currentOriginal = (await this.repository.files({
            force: false,
          })) as TreeElement;

          const paths = this.anonymizedPath.trim().split("/");
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
                  anonymizePath(
                    originalFileName,
                    this.repository.options.terms
                  ) == fileName
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
        } finally {
          span.end();
        }
      });
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
    return trace
      .getTracer("ano-file")
      .startActiveSpan("content", async (span) => {
        try {
          if (this.anonymizedPath.includes(config.ANONYMIZATION_MASK)) {
            await this.originalPath();
          }
          span.addEvent("filePath", { originalPath: this.filePath });
          if (this.fileSize && this.fileSize > config.MAX_FILE_SIZE) {
            throw new AnonymousError("file_too_big", {
              object: this,
              httpStatus: 403,
            });
          }
          const content = await this.repository.source?.getFileContent(this);
          if (
            !this.repository.model.isReseted ||
            this.repository.status != RepositoryStatus.READY
          ) {
            this.repository.model.isReseted = false;
            await this.repository.updateStatus(RepositoryStatus.READY);
          }
          return content;
        } finally {
          span.end();
        }
      });
  }

  async anonymizedContent() {
    const span = trace.getTracer("ano-file").startSpan("Repository.conference");
    span.setAttribute("anonymizedPath", this.anonymizedPath);
    const anonymizer = this.repository.generateAnonymizeTransformer(
      this.anonymizedPath
    );
    if (!config.STREAMER_ENTRYPOINT) {
      // collect the content locally
      const content = await this.content();
      return content.pipe(anonymizer).on("close", () => {
        span.end();
      });
    }
    // use the streamer service
    return got.stream(join(config.STREAMER_ENTRYPOINT, "api"), {
      method: "POST",
      json: {
        token: await this.repository.getToken(),
        repoFullName: this.repository.model.source.repositoryName,
        commit: this.repository.model.source.commit,
        branch: this.repository.model.source.branch,
        repoId: this.repository.repoId,
        filePath: this.filePath,
        sha: await this.sha(),
        anonymizerOptions: anonymizer.opt,
      },
    });
  }

  get filePath() {
    if (!this._originalPath) {
      if (this.anonymizedPath.includes(config.ANONYMIZATION_MASK)) {
        throw new AnonymousError("path_not_defined", {
          object: this,
          httpStatus: 400,
        });
      }
      return this.anonymizedPath;
    }

    return this._originalPath;
  }

  async send(res: Response): Promise<void> {
    const anonymizer = this.repository.generateAnonymizeTransformer(
      this.anonymizedPath
    );
    return trace
      .getTracer("ano-file")
      .startActiveSpan("AnonymizedFile.send", async (span) => {
        span.setAttribute("repoId", this.repository.repoId);
        span.setAttribute("anonymizedPath", this.anonymizedPath);
        return new Promise<void>(async (resolve, reject) => {
          try {
            if (config.STREAMER_ENTRYPOINT) {
              // use the streamer service
              got
                .stream(join(config.STREAMER_ENTRYPOINT, "api"), {
                  method: "POST",
                  json: {
                    token: await this.repository.getToken(),
                    repoFullName: this.repository.model.source.repositoryName,
                    commit: this.repository.model.source.commit,
                    branch: this.repository.model.source.branch,
                    repoId: this.repository.repoId,
                    filePath: this.filePath,
                    sha: await this.sha(),
                    anonymizerOptions: anonymizer.opt,
                  },
                })
                .on("error", () => {
                  handleError(
                    new AnonymousError("file_not_found", {
                      object: this,
                      httpStatus: 404,
                    }),
                    res
                  );
                })
                .pipe(res)
                .on("close", () => {
                  span.end();
                  resolve();
                });
              return;
            }

            const mime = lookup(this.anonymizedPath);
            if (mime && this.extension() != "ts") {
              res.contentType(mime);
            } else if (isTextFile(this.anonymizedPath)) {
              res.contentType("text/plain");
            }
            res.header("Accept-Ranges", "none");
            anonymizer.once("transform", (data) => {
              if (!mime && data.isText) {
                res.contentType("text/plain");
              }
              if (!data.wasAnonimized && this.fileSize) {
                // the text files may be anonymized and therefore the size may be different
                res.header("Content-Length", this.fileSize.toString());
              }
            });
            const content = await this.content();
            function handleStreamError(error: Error) {
              if (!content.closed && !content.destroyed) {
                content.destroy();
              }
              span.recordException(error);
              span.end();
              reject(error);
              // handleError(error, res);
            }
            content
              .on("error", handleStreamError)
              .pipe(anonymizer)
              .pipe(res)
              .on("error", handleStreamError)
              .on("close", () => {
                if (!content.closed && !content.destroyed) {
                  content.destroy();
                }
                span.end();
                resolve();
              });
          } catch (error) {
            handleError(error, res);
          }
        });
      });
  }
}
