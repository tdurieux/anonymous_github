import { Schema } from "mongoose";

const AnonymizedPullRequestSchema = new Schema({
  pullRequestId: {
    type: String,
    index: { unique: true },
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
  owner: Schema.Types.ObjectId,
  conference: String,
  source: {
    pullRequestId: Number,
    repositoryFullName: String,
    accessToken: String,
  },
  options: {
    terms: [String],
    expirationMode: { type: String },
    expirationDate: Date,
    update: Boolean,
    image: Boolean,
    link: Boolean,
    title: Boolean,
    body: Boolean,
    comments: Boolean,
    diff: Boolean,
    origin: Boolean,
    username: Boolean,
    date: Boolean,
  },
  dateOfEntry: {
    type: Date,
    default: new Date(),
  },
  pullRequest: {
    diff: String,
    title: String,
    body: String,
    creationDate: Date,
    updatedDate: Date,
    draft: Boolean,
    merged: Boolean,
    mergedDate: Date,
    state: String,
    baseRepositoryFullName: String,
    headRepositoryFullName: String,
    comments: [
      {
        body: String,
        creationDate: Date,
        updatedDate: Date,
        author: String,
      },
    ],
  },
});

export default AnonymizedPullRequestSchema;
