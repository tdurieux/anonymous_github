import { Schema } from "mongoose";

export const repositoryAccessSchema = new Schema({
  kind: { type: String, enum: ["oauth", "github-app"], required: true },
  repositoryId: Number,
  publicRead: Boolean,
  installationId: Number,
  revision: { type: String, required: true },
}, { _id: false });
