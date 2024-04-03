import { model } from "mongoose";

import { IConferenceDocument, IConferenceModel } from "./conferences.types";
import ConferenceSchema from "./conferences.schema";

const ConferenceModel = model<IConferenceDocument>(
  "Conference",
  ConferenceSchema
) as IConferenceModel;

export default ConferenceModel;
