import { Document, Model } from "mongoose";
import { ConferenceStatus } from "../../types";

export interface IConference {
  name: string;
  conferenceID: string;
  startDate: Date;
  endDate: Date;
  url: string;
  status: ConferenceStatus;
  owners: string[];
  repositories: {
    id: string;
    addDate: Date;
    removeDate?: Date;
  }[];
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
  plan: {
    planID: string;
    pricePerRepository: number;
    quota: {
      repository: number;
      size: number;
      file: number;
    };
  };
  billing?: {
    name: string;
    email: string;
    address: string;
    address2?: string;
    city: string;
    zip: string;
    country: string;
    vat?: string;
  };
}

export interface IConferenceDocument extends IConference, Document {}
export interface IConferenceModel extends Model<IConferenceDocument> {}
