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
  truckedFileList: {
    type: Boolean,
    default: false,
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
