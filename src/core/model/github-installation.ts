import { model, Schema } from "mongoose";

const schema = new Schema({
  appId: { type: String, required: true },
  installationId: { type: Number, required: true },
  accountId: Number,
  accountLogin: String,
  accountType: String,
  blocked: { type: Boolean, default: false },
  reconciliationPending: { type: Boolean, default: false },
  checkedAt: Date,
  revision: String,
});
schema.index({ appId: 1, installationId: 1 }, { unique: true });
export default model("GitHubInstallation", schema);
