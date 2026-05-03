import { Document, Model } from "mongoose";

export interface IUser {
  accessTokens: {
    github: string;
  };
  accessTokenDates?: {
    github: Date;
  };
  externalIDs: {
    github: string;
  };
  username: string;
  isAdmin: boolean;
  apiTokens?: {
    _id?: string;
    tokenHash: string;
    name?: string;
    createdAt?: Date;
    lastUsedAt?: Date;
  }[];
  emails: {
    email: string;
    default: boolean;
  }[];
  photo?: string;

  repositories?: number[];
  default?: {
    terms: string[];
    options: {
      expirationMode: "never" | "redirect" | "";
      update: boolean;
      image: boolean;
      pdf: boolean;
      notebook: boolean;
      link: boolean;
      page: string | null;
    };
  };
  status?: "active" | "removed";
  dateOfEntry?: Date;
  lastUpdated?: Date;
}

export interface IUserDocument extends IUser, Document {
  setLastUpdated: (this: IUserDocument) => Promise<void>;
}
export interface IUserModel extends Model<IUserDocument> {}
