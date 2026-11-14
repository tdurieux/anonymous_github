import { Document, Model } from "mongoose";

export interface IRepository {
  externalId: string;
  name: string;
  url?: string;
  source: "github";
  size?: number;
  defaultBranch?: string;
  hasPage: boolean;
  /** GitHub visibility, refreshed each time the metadata is fetched. */
  private?: boolean;
  pageSource?: {
    branch: string;
    path: string;
  };
  branches?: {
    name: string;
    commit: string;
    readme?: string;
  }[];
}

export interface IRepositoryDocument extends IRepository, Document {
  setLastUpdated: (this: IRepositoryDocument) => Promise<void>;
}
export interface IRepositoryModel extends Model<IRepositoryDocument> {}
