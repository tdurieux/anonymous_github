import * as mongoose from "mongoose";
const { Schema } = mongoose;

const UserSchema = new Schema({
  accessToken: String,
  username: {
    type: String,
    index: { unique: true },
  },
  email: String,
  photo: String,
  repositories: [String],
  default: {
    terms: [String],
    options: {
      expirationMode: { type: String },
      update: Boolean,
      image: Boolean,
      pdf: Boolean,
      notebook: Boolean,
      loc: Boolean,
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
