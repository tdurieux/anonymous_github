import { model } from "mongoose";

import AnonymizedPullRequestSchema from "./anonymizedPullRequests.schema";
import {
  IAnonymizedPullRequestDocument,
  IAnonymizedPullRequestModel,
} from "./anonymizedPullRequests.types";

const AnonymizedPullRequestModel = model<IAnonymizedPullRequestDocument>(
  "AnonymizedPullRequest",
  AnonymizedPullRequestSchema
) as IAnonymizedPullRequestModel;

export default AnonymizedPullRequestModel;
