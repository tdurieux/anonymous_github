import { Schema } from "mongoose";

const UserSchema = new Schema({
  accessTokens: {
    github: { type: String },
  },
  accessTokenDates: {
    github: { type: Date },
  },
  externalIDs: {
    github: { type: String, index: true },
  },
  username: {
    type: String,
    index: { unique: true },
  },
  emails: [
    {
      email: { type: String },
      default: Boolean,
    },
  ],
  isAdmin: { type: Boolean, default: false },
  photo: String,
  repositories: [
    {
      type: String,
      ref: "Repository",
    },
  ],
  default: {
    terms: [String],
    options: {
      expirationMode: { type: String },
      update: Boolean,
      image: Boolean,
      pdf: Boolean,
      notebook: Boolean,
      link: Boolean,
      page: { type: String },
    },
  },
  status: {
    type: String,
    default: "active",
  },
  dateOfEntry: {
    type: Date,
    default: new Date(),
  },
});

export default UserSchema;
