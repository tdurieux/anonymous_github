import { Schema } from "mongoose";

const AnonymizedGistSchema = new Schema({
  gistId: {
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
    gistId: String,
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
    content: Boolean,
    origin: Boolean,
    username: Boolean,
    date: Boolean,
  },
  dateOfEntry: {
    type: Date,
    default: new Date(),
  },
  gist: {
    description: String,
    isPublic: Boolean,
    creationDate: Date,
    updatedDate: Date,
    ownerLogin: String,
    files: [
      {
        filename: String,
        content: String,
        language: String,
        size: Number,
        type: String,
      },
    ],
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

export default AnonymizedGistSchema;
