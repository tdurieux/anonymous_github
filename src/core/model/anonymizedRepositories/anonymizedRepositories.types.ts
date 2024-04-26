import { Document, Model } from "mongoose";
import { RepositoryStatus } from "../../types";

export interface IAnonymizedRepository {
  repoId: string;
  status?: RepositoryStatus;
  statusMessage?: string;
  statusDate: Date;
  anonymizeDate: Date;
  source: {
    type: "GitHubDownload" | "GitHubStream" | "Zip";
    branch?: string;
    commit?: string;
    commitDate?: Date;
    repositoryId?: string;
    repositoryName?: string;
    accessToken?: string;
  };
  owner: string;
  truckedFileList: boolean;
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
  size: {
    storage: number;
    file: number;
  };
  isReseted: boolean;
}

export interface IAnonymizedRepositoryDocument
  extends IAnonymizedRepository,
    Document {
  setLastUpdated: (this: IAnonymizedRepositoryDocument) => Promise<void>;
}
export interface IAnonymizedRepositoryModel
  extends Model<IAnonymizedRepositoryDocument> {}
