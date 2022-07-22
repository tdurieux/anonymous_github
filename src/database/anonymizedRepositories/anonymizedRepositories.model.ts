import { model } from "mongoose";

import {
  IAnonymizedRepositoryDocument,
  IAnonymizedRepositoryModel,
} from "./anonymizedRepositories.types";
import AnonymizedRepositorySchema from "./anonymizedRepositories.schema";

const AnonymizedRepositoryModel = model<IAnonymizedRepositoryDocument>(
  "AnonymizedRepository",
  AnonymizedRepositorySchema
) as IAnonymizedRepositoryModel;

export default AnonymizedRepositoryModel;
