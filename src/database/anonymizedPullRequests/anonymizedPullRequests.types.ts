import { Document, Model } from "mongoose";
import { RepositoryStatus } from "../../types";

export interface IAnonymizedPullRequest {
  pullRequestId: string;
  status?: RepositoryStatus;
  statusMessage?: string;
  statusDate: Date;
  anonymizeDate: Date;
  source: {
    pullRequestId: number;
    repositoryFullName: string;
    accessToken?: string;
  };
  owner: string;
  conference: string;
  options: {
    terms: string[];
    expirationMode: "never" | "redirect" | "remove";
    expirationDate?: Date;
    update: boolean;
    image: boolean;
    link: boolean;
    title: boolean;
    body: boolean;
    comments: boolean;
    diff: boolean;
    origin: boolean;
    username: boolean;
    date: boolean;
  };
  pageView: number;
  lastView: Date;
  pullRequest: {
    diff: string;
    title: string;
    body: string;
    creationDate: Date;
    updatedDate: Date;
    draft?: boolean;
    merged?: boolean;
    mergedDate?: Date;
    state?: string;
    baseRepositoryFullName?: string;
    headRepositoryFullName?: string;
    comments?: {
      body: string;
      creationDate: Date;
      updatedDate: Date;
      author: string;
    }[];
  };
}

export interface IAnonymizedPullRequestDocument
  extends IAnonymizedPullRequest,
    Document {
  setLastUpdated: (this: IAnonymizedPullRequestDocument) => Promise<void>;
}
export interface IAnonymizedPullRequestModel
  extends Model<IAnonymizedPullRequestDocument> {}
