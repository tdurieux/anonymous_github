import { Readable } from "stream";

import AnonymizedFile from "../AnonymizedFile";
import { Tree } from "../types";
import { SourceBase } from "./Source";

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

  abstract getFiles(progress?: (status: string) => void): Promise<Tree>;
}
