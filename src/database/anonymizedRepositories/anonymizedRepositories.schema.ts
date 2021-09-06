import * as mongoose from "mongoose";
const { Schema } = mongoose;

const AnonymizedRepositorySchema = new Schema({
  repoId: {
    type: String,
    index: { unique: true },
  },
  status: {
    type: String,
    default: "preparing",
  },
  errorMessage: String,
  anonymizeDate: Date,
  lastView: Date,
  pageView: Number,
  accessToken: String,
  owner: mongoose.Schema.Types.ObjectId,
  conference: String,
  source: {
    type: { type: String },
    branch: String,
    commit: String,
    repositoryId: String,
    repositoryName: String,
    accessToken: String,
  },
  originalFiles: mongoose.Schema.Types.Mixed,
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
});

export default AnonymizedRepositorySchema;
