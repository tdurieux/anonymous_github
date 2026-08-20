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
    await runRepositoryStatusCheck();
  });
}

export function repositoryMaintenanceQuery(now: Date) {
  const fourMonthAgo = new Date(now);
  fourMonthAgo.setMonth(fourMonthAgo.getMonth() - 4);
  return {
    status: RepositoryStatus.READY,
    $or: [
      {
        "options.expirationMode": { $in: ["redirect", "remove"] },
        "options.expirationDate": { $lte: now },
      },
      {
        isReseted: { $ne: true },
        lastView: { $lt: fourMonthAgo },
      },
    ],
  };
}

export async function runRepositoryStatusCheck(now = new Date()) {
  logger.info("checking repository status and unused repositories");
  const fourMonthAgo = new Date(now);
  fourMonthAgo.setMonth(fourMonthAgo.getMonth() - 4);
  const batch: Promise<void>[] = [];
  const flushBatch = async () => {
    await Promise.all(batch);
    batch.length = 0;
  };

  const cursor = AnonymizedRepositoryModel.find(
    repositoryMaintenanceQuery(now)
  ).cursor();
  for await (const data of cursor) {
    batch.push(
      (async () => {
        const repo = new Repository(data);
        const shouldExpire =
          repo.options.expirationMode !== "never" &&
          repo.options.expirationDate != null &&
          repo.options.expirationDate <= now;
        if (shouldExpire) {
          try {
            await repo.expire();
            logger.info("repository expired", { repoId: repo.repoId });
          } catch (error) {
            logger.error("repository expiration failed", {
              ...serializeError(error),
              repoId: repo.repoId,
            });
          }
          return;
        }

        if (
          repo.model.isReseted !== true &&
          repo.model.lastView < fourMonthAgo
        ) {
          try {
            await repo.removeCache();
            logger.info("removed cache for unused repository", {
              repoId: repo.repoId,
            });
          } catch (error) {
            logger.error("repository cache removal failed", {
              ...serializeError(error),
              repoId: repo.repoId,
            });
          }
        }
      })()
    );
    if (batch.length >= 10) {
      await flushBatch();
    }
  }
  await flushBatch();

  // Repair terminal records left with data by an older or interrupted
  // expiration. This makes the cleanup idempotent across deployments.
  const dirtyTerminalCursor = AnonymizedRepositoryModel.find({
    $or: [
      { status: RepositoryStatus.EXPIRING },
      {
        status: RepositoryStatus.EXPIRED,
        isReseted: { $ne: true },
      },
    ],
  }).cursor();
  for await (const data of dirtyTerminalCursor) {
    batch.push(
      (async () => {
        const repo = new Repository(data);
        try {
          await repo.resetSate();
          await repo.updateStatus(RepositoryStatus.EXPIRED);
          logger.info("recovered expired repository cleanup", {
            repoId: repo.repoId,
          });
        } catch (error) {
          logger.error("expired repository cleanup failed", {
            ...serializeError(error),
            repoId: repo.repoId,
          });
        }
      })()
    );
    if (batch.length >= 10) {
      await flushBatch();
    }
  }
  await flushBatch();
}

export function dailyStatsSnapshot() {
  // snapshot home-page stats once per day at 00:05 UTC
  schedule.scheduleJob("5 0 * * *", async () => {
    logger.info("running daily stats snapshot");
    await computeAndStoreDailyStats();
  });
}
