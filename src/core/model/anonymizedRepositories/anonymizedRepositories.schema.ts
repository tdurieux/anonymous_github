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
  statusMessage: String,
  anonymizeDate: Date,
  lastView: Date,
  pageView: Number,
  accessToken: String,
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
  conference: String,
  source: {
    type: { type: String },
    branch: String,
    commit: String,
    commitDate: Date,
    repositoryId: String,
    repositoryName: String,
    accessToken: String,
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
    default: new Date(),
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

export default AnonymizedRepositorySchema;
