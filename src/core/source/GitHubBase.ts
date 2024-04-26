import { Readable } from "stream";

import AnonymizedFile from "../AnonymizedFile";
import { SourceBase } from "./Source";
import { IFile } from "../model/files/files.types";

export interface GitHubBaseData {
  getToken: () => string | Promise<string>;
  repoId: string;
  organization: string;
  repoName: string;
  commit: string;
}

export default abstract class GitHubBase implements SourceBase {
  abstract type: "GitHubDownload" | "GitHubStream" | "Zip";
  accessToken: string | undefined;

  constructor(readonly data: GitHubBaseData) {}

  abstract getFileContent(
    file: AnonymizedFile,
    progress?: (status: string) => void
  ): Promise<Readable>;

  abstract getFiles(progress?: (status: string) => void): Promise<IFile[]>;
}
