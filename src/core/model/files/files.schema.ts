import { Schema } from "mongoose";

export const UpstreamFileSchema = new Schema({ organization: String, repoName: String, commit: String, path: String }, { _id: false });

const FileSchema = new Schema({
  name: { type: String, index: true },
  path: { type: String },
  repoId: { type: String, index: true },
  treeGeneration: String,
  treeStaged: Boolean,
  metadataPending: Boolean,
  upstream: { type: UpstreamFileSchema, default: undefined },
  submodule: { type: String, enum: ["included", "unsupported", "unavailable", "limit", "nested"] },
  sha: {
    type: String,
  },
  size: {
    type: Number,
  },
});

FileSchema.index({ metadataPending: 1, repoId: 1, treeGeneration: 1 },
  { partialFilterExpression: { metadataPending: true } });
FileSchema.index({ treeStaged: 1, repoId: 1, treeGeneration: 1 },
  { partialFilterExpression: { treeStaged: true } });
FileSchema.index({ repoId: 1, treeGeneration: 1, path: 1, name: 1 });
// Cover generation-scoped count aggregations without fetching every file.
FileSchema.index({ repoId: 1, treeGeneration: 1, path: 1, size: 1 }, { name: "file_counts_covering" });
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
