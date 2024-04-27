import { Schema } from "mongoose";

const FileSchema = new Schema({
  name: { type: String, index: true },
  path: { type: String, index: true },
  repoId: { type: String, index: true },
  sha: {
    type: String,
  },
  size: {
    type: Number,
  },
});

FileSchema.index({ path: 1, repoId: 1 });

FileSchema.methods.toString = function () {
  return `${this.path}/${this.name}`;
};

export default FileSchema;
