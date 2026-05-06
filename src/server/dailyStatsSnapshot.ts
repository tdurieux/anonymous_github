import AnonymizedRepositoryModel from "../core/model/anonymizedRepositories/anonymizedRepositories.model";
import AnonymizedPullRequestModel from "../core/model/anonymizedPullRequests/anonymizedPullRequests.model";
import DailyStatsModel from "../core/model/dailyStats/dailyStats.model";
import { createLogger, serializeError } from "../core/logger";

const logger = createLogger("dailyStats");

export interface HomeStats {
  nbRepositories: number;
  nbUsers: number;
  nbPageViews: number;
  nbPullRequests: number;
}

export async function computeStats(): Promise<HomeStats> {
  const [nbRepositories, nbUsersAgg, nbPageViews, nbPullRequests] =
    await Promise.all([
      AnonymizedRepositoryModel.estimatedDocumentCount(),
      AnonymizedRepositoryModel.collection
        .aggregate([{ $group: { _id: "$owner" } }, { $count: "n" }])
        .toArray(),
      AnonymizedRepositoryModel.collection
        .aggregate([{ $group: { _id: null, total: { $sum: "$pageView" } } }])
        .toArray(),
      AnonymizedPullRequestModel.estimatedDocumentCount(),
    ]);

  return {
    nbRepositories,
    nbUsers: (nbUsersAgg[0] as { n?: number } | undefined)?.n || 0,
    nbPageViews:
      (nbPageViews[0] as { total?: number } | undefined)?.total || 0,
    nbPullRequests,
  };
}

function utcMidnight(d: Date = new Date()): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
}

export async function computeAndStoreDailyStats(): Promise<void> {
  try {
    const stats = await computeStats();
    const date = utcMidnight();
    await DailyStatsModel.updateOne(
      { date },
      { $set: { ...stats, date } },
      { upsert: true }
    );
    logger.info("daily stats snapshot stored", { date, ...stats });
  } catch (error) {
    logger.error("daily stats snapshot failed", serializeError(error));
  }
}

export async function ensureTodaySnapshot(): Promise<void> {
  try {
    const date = utcMidnight();
    const existing = await DailyStatsModel.findOne({ date }).lean();
    if (!existing) {
      await computeAndStoreDailyStats();
    }
  } catch (error) {
    logger.error("ensureTodaySnapshot failed", serializeError(error));
  }
}
