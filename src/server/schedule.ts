import * as schedule from "node-schedule";
import Conference from "../core/Conference";
import AnonymizedRepositoryModel from "../core/model/anonymizedRepositories/anonymizedRepositories.model";
import ConferenceModel from "../core/model/conference/conferences.model";
import Repository from "../core/Repository";
import { createLogger, serializeError } from "../core/logger";
import { computeAndStoreDailyStats } from "./dailyStatsSnapshot";

const logger = createLogger("schedule");

export function conferenceStatusCheck() {
  // check every 6 hours the status of the conferences
  schedule.scheduleJob("0 */6 * * *", async () => {
    (await ConferenceModel.find({ status: { $eq: "ready" } })).forEach(
      async (data) => {
        const conference = new Conference(data);
        if (conference.isExpired() && conference.status == "ready") {
          try {
            await conference.expire();
          } catch (error) {
            logger.error("conference expire failed", serializeError(error));
          }
        }
      }
    );
  });
}

export function repositoryStatusCheck() {
  // check every 6 hours the status of the repositories
  schedule.scheduleJob("0 */6 * * *", async () => {
    logger.info("checking repository status and unused repositories");
    (
      await AnonymizedRepositoryModel.find({
        status: { $eq: "ready" },
        isReseted: { $eq: false },
      })
    ).forEach(async (data) => {
      const repo = new Repository(data);
      try {
        await repo.check();
      } catch {
        logger.info("repository expired", { repoId: repo.repoId });
      }
      const fourMonthAgo = new Date();
      fourMonthAgo.setMonth(fourMonthAgo.getMonth() - 4);

      if (repo.model.lastView < fourMonthAgo) {
        repo.removeCache().then(() => {
          logger.info("removed cache for unused repository", {
            repoId: repo.repoId,
          });
        });
      }
    });
  });
}

export function dailyStatsSnapshot() {
  // snapshot home-page stats once per day at 00:05 UTC
  schedule.scheduleJob("5 0 * * *", async () => {
    logger.info("running daily stats snapshot");
    await computeAndStoreDailyStats();
  });
}
