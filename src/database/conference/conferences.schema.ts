import * as mongoose from "mongoose";
const { Schema } = mongoose;

const RepositorySchema = new Schema({
  name: String,
  conferenceID: String,
  start: Date,
  end: Date,
  status: String,
  owners: [mongoose.Schema.Types.ObjectId],
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
  quota: {
    repository: Number,
    size: Number,
    file: Number,
  },
});

export default RepositorySchema;
