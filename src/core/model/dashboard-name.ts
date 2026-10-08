import { model, Schema } from "mongoose";
const schema = new Schema({ owner: { type: Schema.Types.ObjectId, required: true },
  type: { type: String, required: true }, artifactId: { type: String, required: true }, name: String });
schema.index({ owner: 1, type: 1, artifactId: 1 }, { unique: true });
export default model("DashboardName", schema);
