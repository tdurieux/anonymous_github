import GitHubDownload from "./source/GitHubDownload";
import GitHubStream from "./source/GitHubStream";
import Zip from "./source/ZIP";
import S3Storage from "./storage/S3";
import FileSystem from "./storage/FileSystem";
import AnonymizedFile from "./AnonymizedFile";
import * as stream from "stream";
import * as archiver from "archiver";

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
  getFileContent(file: AnonymizedFile): Promise<stream.Readable>;

  /**
   * Get all the files from a specific source
   */
  getFiles(): Promise<Tree>;

  toJSON(): any;
}

export type Source = GitHubDownload | GitHubStream | Zip;

export interface StorageBase {
  type: string;

  exists(path: string): Promise<boolean>;

  read(path: string): stream.Readable;

  write(path: string, data: Buffer): Promise<void>;

  listFiles(dir: string): Promise<Tree>;

  extractTar(p: string, data: stream.Readable): Promise<void>;

  rm(path: string): Promise<void>;

  archive(
    dir: string,
    opt?: {
      format?: "zip" | "tar";
      fileTransformer?: (p: any) => Transformer;
    }
  ): archiver.Archiver;

  mk(path: string): Promise<void>;
}

export type Storage = S3Storage | FileSystem;

export interface Branch {
  name: string;
  commit: string;
  readme?: string;
}

export type RepositoryStatus =
  | "queue"
  | "preparing"
  | "download"
  | "ready"
  | "expired"
  | "removed";

export type SourceStatus = "available" | "unavailable";

export interface Tree {
  [key: string]: TreeElement;
}

export type TreeElement = Tree | TreeFile;

export interface TreeFile {
  sha: string;
  size: number;
}

export interface Loc {
  info: { total: number; code: number; commit: number };
  languages: {
    [key: string]: {
      total: number;
      code: number;
      commit: number;
      sum: number;
    };
  };
}
