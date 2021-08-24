import * as mongoose from "mongoose";

export interface IConference {
  name: string;
  conferenceID: string;
  start: Date;
  end: Date;
  status: string;
  owners: string[];
  options: {
    expirationMode: "never" | "redirect" | "remove";
    expirationDate?: Date;
    update: boolean;
    image: boolean;
    pdf: boolean;
    notebook: boolean;
    link: boolean;
    page: boolean;
  };
  quota: {
    repository: number;
    size: number;
    file: number;
  };
}

export interface IConferenceDocument extends IConference, mongoose.Document {}
export interface IConferenceModel extends mongoose.Model<IConferenceDocument> {}
