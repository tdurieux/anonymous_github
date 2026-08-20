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
FileSchema.index(
  { repoId: 1, size: 1, path: 1 },
  { name: "repoId_1_size_1_path_1" }
);
FileSchema.index(
  { repoId: 1, path: 1, name: 1 },
  { name: "repoId_1_path_1_name_1" }
);

FileSchema.methods.toString = function () {
  return `${this.path}/${this.name}`;
};

export default FileSchema;
