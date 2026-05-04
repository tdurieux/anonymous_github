import { model } from "mongoose";

import AnonymizedGistSchema from "./anonymizedGists.schema";
import {
  IAnonymizedGistDocument,
  IAnonymizedGistModel,
} from "./anonymizedGists.types";

const AnonymizedGistModel = model<IAnonymizedGistDocument>(
  "AnonymizedGist",
  AnonymizedGistSchema
) as IAnonymizedGistModel;

export default AnonymizedGistModel;
