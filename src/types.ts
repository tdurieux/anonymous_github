import GitHubDownload from "./source/GitHubDownload";
import GitHubStream from "./source/GitHubStream";
import Zip from "./source/Zip";
import S3Storage from "./storage/S3";
import FileSystem from "./storage/FileSystem";
import AnonymizedFile from "./AnonymizedFile";
import { Transform, Readable } from "stream";
import * as archiver from "archiver";
import { Response } from "express";

export interface SourceBase {
  readonly type: string;

  /**
   * The url of the source
   */
  url?: string;

  /**
   * Retrieve the fie content
   * @param file the file of the content to retrieve
   */
  getFileContent(file: AnonymizedFile): Promise<Readable>;

  /**
   * Get all the files from a specific source
   */
  getFiles(): Promise<Tree>;

  toJSON(): any;
}

export type Source = GitHubDownload | GitHubStream | Zip;

export enum FILE_TYPE {
  FILE = "file",
  FOLDER = "folder",
  NOT_FOUND = "not_found",
}

export interface StorageBase {
  /**
   * The type of storage
   */
  type: string;

  /**
   * check if the path exists
   * @param path the path to check
   */
  exists(path: string): Promise<FILE_TYPE>;

  send(p: string, res: Response): Promise<void>;

  /**
   * Read the content of a file
   * @param path the path to the file
   */
  read(path: string): Promise<Readable>;

  fileInfo(path: string): Promise<{
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
  write(
    path: string,
    data: Buffer,
    file?: AnonymizedFile,
    source?: SourceBase
  ): Promise<void>;

  /**
   * List the files from dir
   * @param dir
   */
  listFiles(dir: string): Promise<Tree>;

  /**
   * Extract the content of tar to dir
   * @param dir
   * @param tar
   * @param file the file
   * @param source the source of the file
   */
  extractZip(
    dir: string,
    tar: Readable,
    file?: AnonymizedFile,
    source?: SourceBase
  ): Promise<void>;

  /**
   * Remove the path
   * @param dir
   */
  rm(dir: string): Promise<void>;

  /**
   * Archive the content of dir
   * @param dir
   * @param opt
   */
  archive(
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
  mk(dir: string): Promise<void>;
}

export type Storage = S3Storage | FileSystem;

export interface Branch {
  name: string;
  commit: string;
  readme?: string;
}

export enum RepositoryStatus {
  QUEUE = "queue",
  PREPARING = "preparing",
  DOWNLOAD = "download",
  READY = "ready",
  EXPIRED = "expired",
  EXPIRING = "expiring",
  REMOVED = "removed",
  REMOVING = "removing",
  ERROR = "error",
}

export type ConferenceStatus = "ready" | "expired" | "removed";

export type SourceStatus = "available" | "unavailable";

export type TreeElement = Tree | TreeFile;

export interface Tree {
  [key: string]: TreeElement;
}

export interface TreeFile {
  sha: string;
  size: number;
}
