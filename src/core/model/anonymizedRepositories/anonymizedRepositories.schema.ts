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
  refreshToken: { type: String, select: false },
  refreshUntil: { type: Date, select: false },
  archivedAt: Date,
  archiveReason: String,
  archiveCachePending: Boolean,
  statusMessage: String,
  anonymizeDate: Date,
  settingsSavedAt: Date,
  publishedAt: Date,
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
  cleanupToken: { type: String, select: false },
  cleanupUntil: { type: Date, select: false },
  treeGeneration: String,
  stagedFileTrees: { type: [{ generation: String, until: Date }], default: undefined },
  retiredTreeGenerations: { type: [String], default: undefined },
  retiredContentPrefixes: { type: [String], default: undefined },
  legacyContentCleanupPending: Boolean,
  contentCacheVersion: Number,
  contentCacheRevision: String,
  emptyTreeGeneration: String,
  fileMetadataRevision: String,
  pathIndexKey: String,
  pathIndexBuiltAt: Date,
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
  sizeComputedAt: Date,
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
AnonymizedRepositorySchema.index({ "coauthors.githubId": 1 });
AnonymizedRepositorySchema.index({ retiredTreeGenerations: 1 }, { sparse: true });
AnonymizedRepositorySchema.index({ "stagedFileTrees.until": 1 }, { sparse: true });
AnonymizedRepositorySchema.index({ retiredContentPrefixes: 1 }, { sparse: true });
AnonymizedRepositorySchema.index({ legacyContentCleanupPending: 1, status: 1 },
  { partialFilterExpression: { legacyContentCleanupPending: true } });
AnonymizedRepositorySchema.index({ status: 1, statusDate: 1 });
AnonymizedRepositorySchema.index({ lastView: 1 });
AnonymizedRepositorySchema.index({ anonymizeDate: 1 });
AnonymizedRepositorySchema.index({ status: 1, isReseted: 1, lastView: 1 });
AnonymizedRepositorySchema.index({ status: 1, "options.expirationDate": 1 });
AnonymizedRepositorySchema.index({
  status: 1,
  isReseted: 1,
  "options.expirationDate": 1,
});

export default AnonymizedRepositorySchema;
