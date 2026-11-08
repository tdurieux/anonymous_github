import { Document, Model } from "mongoose";

export interface UpstreamFile {
  organization: string;
  repoName: string;
  commit: string;
  path: string;
}

export interface IFile {
  /** Internal source metadata, never returned by the public tree API. */
  upstream?: UpstreamFile;
  submodule?: "included" | "unsupported" | "unavailable" | "limit" | "nested";
  name: string;
  path: string;
  repoId: string;
  treeGeneration?: string;
  treeStaged?: boolean;
  metadataPending?: boolean;
  sha?: string;
  size?: number;
}

export interface IFileDocument extends IFile, Document {
  toString: (this: IFileDocument) => string;
}
export interface IFileModel extends Model<IFileDocument> {}
