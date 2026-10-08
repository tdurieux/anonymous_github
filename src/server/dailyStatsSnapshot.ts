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

export interface HomeStatsHistoryRow extends HomeStats {
  date: Date;
}

export async function computeStats(): Promise<HomeStats> {
  const [nbRepositories, usageTotals, nbPullRequests] =
    await Promise.all([
      AnonymizedRepositoryModel.estimatedDocumentCount(),
      AnonymizedRepositoryModel.collection
        .aggregate([
          {
            $group: {
              _id: "$owner",
              pageViews: { $sum: "$pageView" },
            },
          },
          {
            $group: {
              _id: null,
              nbUsers: { $sum: 1 },
              nbPageViews: { $sum: "$pageViews" },
            },
          },
        ])
        .toArray(),
      AnonymizedPullRequestModel.estimatedDocumentCount(),
    ]);

  const usage = usageTotals[0] as
    | { nbUsers?: number; nbPageViews?: number }
    | undefined;

  return {
    nbRepositories,
    nbUsers: usage?.nbUsers || 0,
    nbPageViews: usage?.nbPageViews || 0,
    nbPullRequests,
  };
}

function utcMidnight(d: Date = new Date()): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
}

export function mergeCurrentStatsIntoHistory(
  rows: HomeStatsHistoryRow[],
  currentStats: HomeStats,
  now: Date = new Date()
): HomeStatsHistoryRow[] {
  const today = utcMidnight(now);
  const history = rows.map((row) => ({
    ...row,
    date: new Date(row.date),
  }));
  const currentRow = { date: today, ...currentStats };
  const todayTime = today.getTime();
  const todayIndex = history.findIndex(
    (row) => utcMidnight(row.date).getTime() === todayTime
  );

  if (todayIndex >= 0) {
    history[todayIndex] = currentRow;
  } else {
    history.push(currentRow);
  }

  return history.sort((a, b) => a.date.getTime() - b.date.getTime());
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

// Shared by /stat and /stat/history; zero counts are valid cache entries.
import { AsyncCache } from "../core/async-cache";
import { cacheRedis, cacheCommand, coordinatedFill } from "../core/cache-coordination";
const currentStatsCache = new AsyncCache<HomeStats>(60 * 60_000, 1);
const historyCache = new AsyncCache<HomeStatsHistoryRow[]>(60 * 60_000, 16);
export function clearStatsCache() { currentStatsCache.clear(); historyCache.clear(); }
export function getCurrentStats(): Promise<HomeStats> {
  return currentStatsCache.get("current", async () => {
    const redis = await cacheRedis();
    const key = "perf:home-stats:v1";
    const read = async () => {
      if (!redis?.isReady) return undefined;
      const value = await cacheCommand(redis.get(key), redis).catch(() => null);
      if (!value) return undefined;
      try { return JSON.parse(value) as HomeStats; } catch { return undefined; }
    };
    return coordinatedFill(key, read, async () => {
      const stats = await computeStats();
      if (redis?.isReady) await cacheCommand(redis.set(key, JSON.stringify(stats), { PX: 60 * 60_000 }), redis).catch(() => {});
      return stats;
    });
  });
}
export function getStatsHistory(days: number, now = new Date()) {
  const count = Math.min(365, Math.max(1, Math.floor(days) || 30));
  const today = utcMidnight(now);
  return historyCache.get(`${today.toISOString()}:${count}`, async () => {
    const since = new Date(today);
    since.setUTCDate(since.getUTCDate() - count + 1);
    const [docs, current] = await Promise.all([
      DailyStatsModel.find({ date: { $gte: since } }).sort({ date: 1 }).lean(),
      getCurrentStats(),
    ]);
    return mergeCurrentStatsIntoHistory(docs.map(d => ({ date: d.date,
      nbRepositories: d.nbRepositories, nbUsers: d.nbUsers,
      nbPageViews: d.nbPageViews, nbPullRequests: d.nbPullRequests })), current, now);
  });
}
