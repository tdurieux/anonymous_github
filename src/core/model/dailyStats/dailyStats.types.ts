import { Document, Model } from "mongoose";

export interface IDailyStats {
  date: Date;
  nbRepositories: number;
  nbUsers: number;
  nbPageViews: number;
  nbPullRequests: number;
}

export interface IDailyStatsDocument extends IDailyStats, Document {}
export interface IDailyStatsModel extends Model<IDailyStatsDocument> {}
