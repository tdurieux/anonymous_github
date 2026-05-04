import { Document, Model } from "mongoose";
import { RepositoryStatus } from "../../types";

export interface IAnonymizedGist {
  gistId: string;
  status?: RepositoryStatus;
  statusMessage?: string;
  statusDate: Date;
  anonymizeDate: Date;
  source: {
    gistId: string;
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
    content: boolean;
    origin: boolean;
    username: boolean;
    date: boolean;
  };
  pageView: number;
  lastView: Date;
  gist: {
    description: string;
    isPublic?: boolean;
    creationDate: Date;
    updatedDate: Date;
    ownerLogin?: string;
    files?: {
      filename: string;
      content: string;
      language?: string;
      size?: number;
      type?: string;
    }[];
    comments?: {
      body: string;
      creationDate: Date;
      updatedDate: Date;
      author: string;
    }[];
  };
}

export interface IAnonymizedGistDocument extends IAnonymizedGist, Document {
  setLastUpdated: (this: IAnonymizedGistDocument) => Promise<void>;
}
export interface IAnonymizedGistModel extends Model<IAnonymizedGistDocument> {}
