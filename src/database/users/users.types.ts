import * as mongoose from "mongoose";

export interface IUser {
  accessToken: string;

  username: string;
  email: string;
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

export interface IUserDocument extends IUser, mongoose.Document {
  setLastUpdated: (this: IUserDocument) => Promise<void>;
}
export interface IUserModel extends mongoose.Model<IUserDocument> {}
