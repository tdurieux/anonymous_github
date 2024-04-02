import { Readable } from "stream";

import AnonymizedFile from "../AnonymizedFile";
import { Tree } from "../types";

export interface GitHubBaseData {
  getToken: () => string | Promise<string>;
  repoId: string;
  organization: string;
  repoName: string;
  commit: string;
}

export interface SourceBase {
  readonly type: string;

  /**
   * Retrieve the fie content
   * @param file the file of the content to retrieve
   */
  getFileContent(file: AnonymizedFile): Promise<Readable>;

  /**
   * Get all the files from a specific source
   */
  getFiles(progress?: (status: string) => void): Promise<Tree>;
}

export default abstract class GitHubBase implements SourceBase {
  abstract type: "GitHubDownload" | "GitHubStream" | "Zip";
  accessToken: string | undefined;

  constructor(readonly data: GitHubBaseData) {}

  abstract getFileContent(
    file: AnonymizedFile,
    progress?: (status: string) => void
  ): Promise<Readable>;

  abstract getFiles(progress?: (status: string) => void): Promise<Tree>;
}
