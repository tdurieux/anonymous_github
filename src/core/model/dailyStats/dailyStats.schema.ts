import { Schema } from "mongoose";

const DailyStatsSchema = new Schema({
  date: { type: Date, unique: true, index: true },
  nbRepositories: { type: Number, default: 0 },
  nbUsers: { type: Number, default: 0 },
  nbPageViews: { type: Number, default: 0 },
  nbPullRequests: { type: Number, default: 0 },
});

export default DailyStatsSchema;
