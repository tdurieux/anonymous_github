import * as schedule from "node-schedule";
import Conference from "../core/Conference";
import AnonymizedRepositoryModel from "../core/model/anonymizedRepositories/anonymizedRepositories.model";
import ConferenceModel from "../core/model/conference/conferences.model";
import Repository from "../core/Repository";
import { createLogger, serializeError } from "../core/logger";
import { RepositoryStatus } from "../core/types";
import { computeAndStoreDailyStats } from "./dailyStatsSnapshot";

const logger = createLogger("schedule");

export function conferenceStatusCheck() {
  // check every 6 hours the status of the conferences
  schedule.scheduleJob("0 */6 * * *", async () => {
    const cursor = ConferenceModel.find({
      status: "ready",
      endDate: { $lte: new Date() },
    }).cursor();
    for await (const data of cursor) {
      const conference = new Conference(data);
      try {
        await conference.expire();
      } catch (error) {
        logger.error("conference expire failed", serializeError(error));
      }
    }
  });
}

export function repositoryStatusCheck() {
  // check every 6 hours the status of the repositories
  schedule.scheduleJob("0 */6 * * *", async () => {
    logger.info("checking repository status and unused repositories");
    const now = new Date();
    const fourMonthAgo = new Date(now);
    fourMonthAgo.setMonth(fourMonthAgo.getMonth() - 4);
    const cursor = AnonymizedRepositoryModel.find({
      status: RepositoryStatus.READY,
      isReseted: false,
      $or: [
        {
          "options.expirationMode": { $in: ["redirect", "remove"] },
          "options.expirationDate": { $lte: now },
        },
        { lastView: { $lt: fourMonthAgo } },
      ],
    }).cursor();
    const batch: Promise<void>[] = [];
    for await (const data of cursor) {
      batch.push(
        (async () => {
          const repo = new Repository(data);
          try {
            await repo.check();
          } catch {
            logger.info("repository expired", { repoId: repo.repoId });
          }

          if (repo.model.lastView < fourMonthAgo) {
            try {
              await repo.removeCache();
            } catch (error) {
              logger.error("repository cache removal failed", {
                ...serializeError(error),
                repoId: repo.repoId,
              });
              return;
            }
            logger.info("removed cache for unused repository", {
              repoId: repo.repoId,
            });
          }
        })()
      );
      if (batch.length >= 10) {
        await Promise.all(batch);
        batch.length = 0;
      }
    }
    await Promise.all(batch);
  });
}

export function dailyStatsSnapshot() {
  // snapshot home-page stats once per day at 00:05 UTC
  schedule.scheduleJob("5 0 * * *", async () => {
    logger.info("running daily stats snapshot");
    await computeAndStoreDailyStats();
  });
}
