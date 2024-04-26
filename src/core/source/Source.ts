import { Readable } from "stream";

import AnonymizedFile from "../AnonymizedFile";
import GitHubDownload from "./GitHubDownload";
import GitHubStream from "./GitHubStream";
import Zip from "./Zip";
import { IFile } from "../model/files/files.types";

export type Source = GitHubDownload | GitHubStream | Zip;

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
  getFiles(progress?: (status: string) => void): Promise<IFile[]>;
}
