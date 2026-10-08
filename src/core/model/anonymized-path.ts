import { IFile } from "./files/files.types";
import { model, Schema } from "mongoose";
const schema = new Schema({ repoId: { type: String, required: true }, key: { type: String, required: true }, originalId: Schema.Types.ObjectId,
  name: { type: String, required: true }, path: { type: String, default: "", required: true }, sha: String, size: Number,
  anonymousName: String, anonymousDirectory: String, anonymousPath: String,
  searchName: String, searchDirectory: String,
  createdAt: { type: Date, default: Date.now } });
schema.index({ repoId: 1, key: 1, anonymousPath: 1, path: 1, name: 1 });
schema.index({ repoId: 1, key: 1, originalId: 1 }, { unique: true });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
export default model<IFile & { key: string; originalId: Schema.Types.ObjectId; anonymousName: string; anonymousDirectory: string; anonymousPath: string; searchName: string; searchDirectory: string; createdAt: Date }>("AnonymizedPath", schema);
