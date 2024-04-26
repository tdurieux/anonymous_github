import { Document, Model } from "mongoose";

export interface IFile {
  name: string;
  path: string;
  repoId: string;
  sha?: string;
  size?: number;
}

export interface IFileDocument extends IFile, Document {
  toString: (this: IFileDocument) => string;
}
export interface IFileModel extends Model<IFileDocument> {}
