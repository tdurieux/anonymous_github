import { Schema } from "mongoose";

const RepositorySchema = new Schema({
  name: String,
  conferenceID: {
    type: String,
    index: { unique: true },
  },
  url: String,
  startDate: Date,
  endDate: Date,
  status: String,
  owners: { type: [Schema.Types.ObjectId] },
  repositories: {
    type: [
      {
        id: { type: Schema.Types.ObjectId },
        addDate: { type: Date },
        removeDate: { type: Date },
      },
    ],
  },
  options: {
    expirationMode: String,
    expirationDate: Date,
    update: Boolean,
    image: Boolean,
    pdf: Boolean,
    notebook: Boolean,
    link: Boolean,
    page: Boolean,
  },
  dateOfEntry: {
    type: Date,
    default: new Date(),
  },
  plan: {
    planID: String,
    pricePerRepository: Number,
    quota: {
      repository: Number,
      size: Number,
      file: Number,
    },
  },
  billing: {
    name: String,
    email: String,
    address: String,
    address2: String,
    city: String,
    zip: String,
    country: String,
    vat: String,
  },
});

export default RepositorySchema;
