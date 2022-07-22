import { Schema } from "mongoose";

const RepositorySchema = new Schema({
  externalId: {
    type: String,
    index: { unique: true },
  },
  name: {
    type: String,
    index: true,
  },
  url: String,
  source: {
    type: String,
    default: "github",
  },
  hasPage: { type: Boolean, default: false },
  pageSource: {
    branch: { type: String },
    path: String,
  },
  branches: [
    {
      name: { type: String },
      commit: String,
      readme: String,
    },
  ],
  defaultBranch: String,
  size: Number,
  status: {
    type: String,
    default: "ready",
  },
  dateOfEntry: {
    type: Date,
    default: new Date(),
  },
});

export default RepositorySchema;
