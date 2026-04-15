import { join, basename, dirname } from "path";
import { Response } from "express";
import { Readable } from "stream";
import { lookup } from "mime-types";
import got from "got";

import Repository from "./Repository";
import { RepositoryStatus } from "./types";
import config from "../config";
import { anonymizePath, isTextFile } from "./anonymize-utils";
import AnonymousError from "./AnonymousError";
import { handleError } from "../server/routes/route-utils";
import FileModel from "./model/files/files.model";
import { IFile } from "./model/files/files.types";
import { FilterQuery } from "mongoose";

/**
 * Represent a file in a anonymized repository
 */
export default class AnonymizedFile {
  repository: Repository;
  anonymizedPath: string;

  private _file?: IFile | null;

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
    if (this._file) return this._file.sha?.replace(/"/g, "");
    this._file = await this.getFileInfo();
    return this._file.sha?.replace(/"/g, "");
  }

  async getFileInfo(): Promise<IFile> {
    if (this._file) return this._file;
    let fileDir = dirname(this.anonymizedPath);
    if (fileDir == ".") fileDir = "";
    if (fileDir.endsWith("/")) fileDir = fileDir.slice(0, -1);
    const filename = basename(this.anonymizedPath);

    if (!this.anonymizedPath.includes(config.ANONYMIZATION_MASK)) {
      if (this.anonymizedPath == "") {
        return {
          name: "",
          path: "",
          repoId: this.repository.repoId,
        };
      }
      const query: FilterQuery<IFile> = {
        repoId: this.repository.repoId,
        path: fileDir,
      };
      if (filename != "") query.name = filename;
      const res = await FileModel.findOne(query);
      if (res) {
        this._file = res;
        return res;
      }
      throw new AnonymousError("file_not_found", {
        object: this,
        httpStatus: 404,
      });
    }

    const pathQuery = fileDir
      .split("/")
      .map((p) => {
        if (p.includes(config.ANONYMIZATION_MASK)) {
          return "[^/]+";
        }
        return p;
      })
      .join("/");
    const nameQuery = filename.replace(
      new RegExp(config.ANONYMIZATION_MASK + "(-[0-9]+)?"),
      "[^/]+"
    );

    const candidates = await FileModel.find({
      repoId: this.repository.repoId,
      path: new RegExp(pathQuery),
      name: new RegExp(nameQuery),
    }).exec();

    for (const candidate of candidates) {
      const candidatePath = join(candidate.path, candidate.name);
      if (
        anonymizePath(candidatePath, this.repository.options.terms || []) ==
        this.anonymizedPath
      ) {
        this._file = candidate;
        return candidate;
      }
    }
    throw new AnonymousError("file_not_found", {
      object: this,
      httpStatus: 404,
    });
  }

  /**
   * De-anonymize the path
   *
   * @returns the origin relative path of the file
   */
  async originalPath(): Promise<string> {
    if (this.anonymizedPath == null) {
      throw new AnonymousError("path_not_specified", {
        object: this,
        httpStatus: 400,
      });
    }
    if (!this._file) {
      this._file = await this.getFileInfo();
    }
    return join(this._file.path, this._file.name);
  }
  extension() {
    const filename = basename(this._file?.name || this.anonymizedPath);
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
    if (this._file?.size && this._file?.size > config.MAX_FILE_SIZE) {
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
  }

  async anonymizedContent() {
    const anonymizer = this.repository.generateAnonymizeTransformer(
      this.anonymizedPath
    );
    if (!config.STREAMER_ENTRYPOINT) {
      // collect the content locally
      const content = await this.content();
      return content.pipe(anonymizer);
    }

    // const cacheableLookup = new CacheableLookup();
    // const hostName = new URL(config.STREAMER_ENTRYPOINT).hostname;
    // const ipHost = await cacheableLookup.lookupAsync(hostName);

    // use the streamer service
    return got.stream(join(config.STREAMER_ENTRYPOINT, "api"), {
      method: "POST",
      // lookup: cacheableLookup.lookup,
      // host: ipHost.address,
      // dnsCache: cacheableLookup,
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
    if (!this._file) {
      if (this.anonymizedPath.includes(config.ANONYMIZATION_MASK)) {
        throw new AnonymousError("path_not_defined", {
          object: this,
          httpStatus: 400,
        });
      }
      return this.anonymizedPath;
    }

    return join(this._file.path, this._file.name);
  }

  // cacheableLookup = new CacheableLookup({
  //   maxTtl: 60,
  // });

  async send(res: Response): Promise<void> {
    const anonymizer = this.repository.generateAnonymizeTransformer(
      this.anonymizedPath
    );
    return new Promise<void>(async (resolve, reject) => {
      try {
        if (config.STREAMER_ENTRYPOINT) {
          // use the streamer service
          const [sha, token] = await Promise.all([
            this.sha(),
            this.repository.getToken(),
          ]);
          const resStream = got
            .stream(join(config.STREAMER_ENTRYPOINT, "api"), {
              method: "POST",
              json: {
                sha,
                token,
                repoFullName: this.repository.model.source.repositoryName,
                commit: this.repository.model.source.commit,
                branch: this.repository.model.source.branch,
                repoId: this.repository.repoId,
                filePath: this.filePath,
                anonymizerOptions: anonymizer.opt,
              },
            })
            .on("error", (err) => {
              handleError(
                new AnonymousError("file_not_found", {
                  object: this,
                  httpStatus: 404,
                }),
                res
              );
            });
          resStream.pipe(res);
          res.on("close", () => {
            resolve();
          });
          res.on("error", (err) => {
            reject(err);
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
          if (!data.wasAnonimized && this._file?.size) {
            // the text files may be anonymized and therefore the size may be different
            res.header("Content-Length", this._file?.size.toString());
          }
        });
        const content = await this.content();
        function handleStreamError(error: Error) {
          if (!content.closed && !content.destroyed) {
            content.destroy();
          }
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
            resolve();
          });
      } catch (error) {
        handleError(error, res);
      }
    });
  }
}
