import { join } from "path";
import { Transform, Readable } from "stream";
import * as archiver from "archiver";
import { Response } from "express";

import S3Storage from "./S3";
import FileSystem from "./FileSystem";
import { IFile } from "../model/files/files.types";
import AnonymousError from "../AnonymousError";

export type Storage = S3Storage | FileSystem;

export enum FILE_TYPE {
  FILE = "file",
  FOLDER = "folder",
  NOT_FOUND = "not_found",
}

export default abstract class StorageBase {
  /**
   * The type of storage
   */
  abstract type: string;

  /**
   * check if the path exists
   * @param path the path to check
   */
  abstract exists(repoId: string, path: string): Promise<FILE_TYPE>;

  abstract send(repoId: string, path: string, res: Response): Promise<void>;

  /**
   * Read the content of a file
   * @param path the path to the file
   */
  abstract read(repoId: string, path: string): Promise<Readable>;

  abstract fileInfo(
    repoId: string,
    path: string
  ): Promise<{
    size: number | undefined;
    lastModified: Date | undefined;
    contentType: string;
  }>;

  /**
   * Write data to a file
   * @param path the path to the file
   * @param data the content of the file
   * @param file the file
   * @param source the source of the file
   */
  abstract write(
    repoId: string,
    path: string,
    data: string | Readable,
    source?: string,
    /**
     * Expected number of bytes for the source. When provided and the
     * stream produces fewer bytes (a truncated upstream response, a socket
     * reset that didn't surface as an error, etc.), the write is rejected
     * and any partial blob is removed instead of being committed. This is
     * the load-bearing guard that keeps zero-byte cache entries from
     * silently shadowing real files on subsequent reads.
     */
    expectedSize?: number
  ): Promise<void>;

  /**
   * List the files from dir
   * @param dir
   */
  abstract listFiles(repoId: string, dir: string): Promise<IFile[]>;

  /**
   * Extract the content of tar to dir
   * @param dir
   * @param tar
   * @param file the file
   * @param source the source of the file
   */
  abstract extractZip(
    repoId: string,
    dir: string,
    tar: Readable,
    source?: string
  ): Promise<void>;

  /**
   * Remove the path
   * @param dir
   */
  abstract rm(repoId: string, dir: string): Promise<void>;

  /**
   * Archive the content of dir
   * @param dir
   * @param opt
   */
  abstract archive(
    repoId: string,
    dir: string,
    opt?: {
      /**
       * Archive format
       */
      format?: "zip" | "tar";
      /**
       * Transformer to apply on the content of the file
       */
      fileTransformer?: (p: string) => Transform;
    }
  ): Promise<archiver.Archiver>;

  /**
   * Create a directory
   * @param dir
   */
  abstract mk(repoId: string, dir: string): Promise<void>;

  repoPath(repoId: string) {
    return (
      join(repoId, "original") + (process.platform === "win32" ? "\\" : "/")
    );
  }

  /**
   * Reject any path/dir argument that could escape the per-repo base
   * directory (filesystem) or key prefix (S3) once joined. The storage
   * methods take a path component that ultimately derives from the request
   * URL; `path.join`/key concatenation normalises `../` but does NOT stop it
   * from climbing above the base. Validating the raw component before it is
   * joined is the load-bearing defence against path traversal / zip-slip
   * (CWE-22/23/24) for both backends.
   *
   * Throws AnonymousError(400) when the path is absolute or contains a `..`
   * segment. An empty string (the repo root) is allowed.
   */
  protected assertSafePath(p: string | undefined): void {
    if (p == null || p === "") return;
    if (typeof p !== "string") {
      throw new AnonymousError("invalid_path", {
        httpStatus: 400,
        object: String(p),
      });
    }
    // Absolute paths (POSIX "/x", Windows "C:\x" / "\x") must not be allowed
    // to override the base in a join.
    if (/^([a-zA-Z]:)?[\\/]/.test(p)) {
      throw new AnonymousError("invalid_path", { httpStatus: 400, object: p });
    }
    for (const segment of p.split(/[\\/]/)) {
      if (segment === "..") {
        throw new AnonymousError("invalid_path", {
          httpStatus: 400,
          object: p,
        });
      }
    }
  }

  /**
   * Sanitise a single zip entry name during extraction. The archive
   * extractors strip the leading top-level directory of each entry; this
   * additionally drops any `..` / absolute components so a crafted entry like
   * `repo/../../../etc/crontab` cannot escape the extraction root
   * (zip-slip, CWE-23/24). Returns "" when nothing safe remains.
   */
  protected sanitizeZipEntryName(name: string): string {
    return name
      .split(/[\\/]/)
      .filter(
        (segment) =>
          segment !== "" && segment !== "." && segment !== ".."
      )
      .join("/");
  }
}
