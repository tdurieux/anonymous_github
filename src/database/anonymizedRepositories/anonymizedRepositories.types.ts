import * as mongoose from "mongoose";
import { RepositoryStatus, Tree } from "../../types";

export interface IAnonymizedRepository {
  repoId: string;
  status?: RepositoryStatus;
  errorMessage?: string;
  anonymizeDate: Date;
  source: {
    type: "GitHubDownload" | "GitHubStream" | "Zip";
    branch?: string;
    commit?: string;
    repositoryId?: string;
    repositoryName?: string;
    accessToken?: string;
  };
  owner: string;
  originalFiles: Tree;
  conference: string;
  options: {
    terms: string[];
    expirationMode: "never" | "redirect" | "remove";
    expirationDate?: Date;
    update: boolean;
    image: boolean;
    pdf: boolean;
    notebook: boolean;
    link: boolean;
    page: boolean;
    pageSource?: {
      branch: string;
      path: string;
    };
  };
  pageView: number;
  lastView: Date;
  size: number;
}

export interface IAnonymizedRepositoryDocument
  extends IAnonymizedRepository,
    mongoose.Document {
  setLastUpdated: (this: IAnonymizedRepositoryDocument) => Promise<void>;
}
export interface IAnonymizedRepositoryModel
  extends mongoose.Model<IAnonymizedRepositoryDocument> {}
