import { model } from "mongoose";

import { IDailyStatsDocument, IDailyStatsModel } from "./dailyStats.types";
import DailyStatsSchema from "./dailyStats.schema";

const DailyStatsModel = model<IDailyStatsDocument>(
  "DailyStats",
  DailyStatsSchema
) as IDailyStatsModel;

export default DailyStatsModel;
