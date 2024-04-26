import { join } from "path";
import { Transform, Readable } from "stream";
import * as archiver from "archiver";
import { Response } from "express";

import S3Storage from "./S3";
import FileSystem from "./FileSystem";
import { IFile } from "../model/files/files.types";

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
    source?: string
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
}
