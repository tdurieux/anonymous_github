import { model } from "mongoose";

import { IRepositoryDocument, IRepositoryModel } from "./repositories.types";
import RepositorySchema from "./repositories.schema";

const RepositoryModel = model<IRepositoryDocument>(
  "Repository",
  RepositorySchema
) as IRepositoryModel;

export default RepositoryModel;
