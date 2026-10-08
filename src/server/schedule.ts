import { Model, Document } from "mongoose";
import * as schedule from "node-schedule";
import AnonymizedGistModel from "../core/model/anonymizedGists/anonymizedGists.model";
import AnonymizedPullRequestModel from "../core/model/anonymizedPullRequests/anonymizedPullRequests.model";
import Gist from "../core/Gist";
import PullRequest from "../core/PullRequest";
import Conference from "../core/Conference";
import AnonymizedRepositoryModel from "../core/model/anonymizedRepositories/anonymizedRepositories.model";
import ConferenceModel from "../core/model/conference/conferences.model";
import Repository from "../core/Repository";
import FileModel from "../core/model/files/files.model";
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
  // Claim persisted expiration work every five minutes, without overlapping runs.
  let running = false;
  schedule.scheduleJob("*/5 * * * *", async () => {
    if (running) return;
    running = true;
    try { await runRepositoryStatusCheck(); } finally { running = false; }
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
          await repo.expire();
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
  await expireContent(AnonymizedGistModel, data => new Gist(data), now);
  await expireContent(AnonymizedPullRequestModel, data => new PullRequest(data), now);

  const retiredCursor = AnonymizedRepositoryModel.find({ $or: [
    { retiredTreeGenerations: { $exists: true } }, { retiredContentPrefixes: { $exists: true } },
    { legacyContentCleanupPending: true, status: RepositoryStatus.READY },
  ] }).cursor();
  for await (const data of retiredCursor) {
    batch.push(new Repository(data).cleanupRetiredFileTrees().catch(error => {
      logger.error("retired tree cleanup failed", { ...serializeError(error), repoId: data.repoId });
    }));
    if (batch.length >= 10) await flushBatch();
  }
  await flushBatch();

  const pendingCursor = FileModel.find({ metadataPending: true }).cursor();
  for await (const file of pendingCursor) {
    batch.push((async () => {
      try {
        const data = await AnonymizedRepositoryModel.findOne({ repoId: file.repoId }).exec();
        if (!data || data.treeGeneration !== file.treeGeneration ||
          (data.status && [RepositoryStatus.EXPIRING, RepositoryStatus.EXPIRED, RepositoryStatus.REMOVING, RepositoryStatus.REMOVED].includes(data.status))) {
          await FileModel.deleteOne({ _id: file._id, metadataPending: true }).exec();
          return;
        }
        await new Repository(data).completeRecoveredFileMetadata(file);
      } catch (error) {
        logger.error("recovered file invalidation failed", { ...serializeError(error), repoId: file.repoId });
      }
    })());
    if (batch.length >= 10) await flushBatch();
  }
  await flushBatch();
}
async function expireContent<T extends Document>(model: Model<T>, create: (data: T) => Gist | PullRequest, now: Date) {
    const cursor = model.find(contentMaintenanceQuery(now)).cursor();
    for await (const data of cursor) {
      try { await create(data).expire(); } catch (error) { logger.error("content expiration failed", serializeError(error)); }
    }
}

export function contentMaintenanceQuery(now: Date) {
  return { $or: [{ status: RepositoryStatus.EXPIRING },
    { status: RepositoryStatus.READY, "options.expirationMode": { $ne: "never" }, "options.expirationDate": { $lte: now } }] };
}

export function dailyStatsSnapshot() {
  // snapshot home-page stats once per day at 00:05 UTC
  schedule.scheduleJob("5 0 * * *", async () => {
    logger.info("running daily stats snapshot");
    await computeAndStoreDailyStats();
  });
}
