import { repositoryAccessSchema } from "../repository-access.schema";
import { Schema } from "mongoose";

const AnonymizedRepositorySchema = new Schema({
  repoId: {
    type: String,
    index: { unique: true, collation: { locale: "en", strength: 2 } },
  },
  status: {
    type: String,
    default: "preparing",
  },
  statusDate: Date,
  archivedAt: Date,
  archiveReason: String,
  archiveCachePending: Boolean,
  statusMessage: String,
  anonymizeDate: Date,
  lastView: Date,
  pageView: Number,
  accessToken: { type: String, select: false },
  owner: {
    type: Schema.Types.ObjectId,
    ref: "user",
    index: true,
  },
  coauthors: [
    {
      username: { type: String, index: true },
      githubId: { type: String },
      photo: { type: String },
      addedAt: { type: Date, default: Date.now },
    },
  ],
  githubAccess: { type: repositoryAccessSchema, default: undefined },
  conference: String,
  source: {
    type: { type: String },
    branch: String,
    commit: String,
    commitDate: Date,
    repositoryId: String,
    repositoryName: String,
    accessToken: { type: String, select: false },
  },
  truncatedFolders: {
    type: [String],
    default: [],
  },
  options: {
    terms: [String],
    expirationMode: { type: String },
    expirationDate: Date,
    update: Boolean,
    image: Boolean,
    pdf: Boolean,
    notebook: Boolean,
    link: Boolean,
    page: Boolean,
    pageSource: {
      branch: String,
      path: String,
    },
  },
  dateOfEntry: {
    type: Date,
    default: Date.now,
  },
  size: {
    storage: {
      type: Number,
      default: 0,
    },
    file: {
      type: Number,
      default: 0,
    },
  },
  isReseted: {
    type: Boolean,
    default: false,
  },
});

AnonymizedRepositorySchema.index({ "source.repositoryName": 1 });
AnonymizedRepositorySchema.index({ status: 1, statusDate: 1 });
AnonymizedRepositorySchema.index({ lastView: 1 });
AnonymizedRepositorySchema.index({ anonymizeDate: 1 });
AnonymizedRepositorySchema.index({ status: 1, isReseted: 1, lastView: 1 });
AnonymizedRepositorySchema.index({
  status: 1,
  isReseted: 1,
  "options.expirationDate": 1,
});

export default AnonymizedRepositorySchema;
