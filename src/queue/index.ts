import { JobsOptions, Queue, Worker } from "bullmq";
import config from "../config";
import AnonymizedRepositoryModel from "../core/model/anonymizedRepositories/anonymizedRepositories.model";
import { RepositoryStatus } from "../core/types";
import * as path from "path";
import { createLogger, serializeError } from "../core/logger";
import { recordMetric } from "./queueMetrics";

const logger = createLogger("queue");

// Minimal payload for queue jobs. Workers re-fetch the Repository from the
// database via getRepository(repoId), so passing the full Mongoose-backed
// Repository instance through msgpackr is unnecessary — and triggers
// ERR_BUFFER_OUT_OF_BOUNDS on long term lists / large nested fields.
export interface RepoJobData {
  repoId: string;
}

const IN_FLIGHT_STATUSES: RepositoryStatus[] = [
  RepositoryStatus.PREPARING,
  RepositoryStatus.QUEUE,
  RepositoryStatus.DOWNLOAD,
];

const LIVE_JOB_STATES = new Set([
  "active",
  "waiting",
  "delayed",
  "prioritized",
  "waiting-children",
]);

const REMOVAL_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: true,
  // Keep a bounded failure history so operators can inspect and retry jobs.
  removeOnFail: { count: 1000 },
};

async function markErrorIfInFlight(repoId: string, message: string) {
  try {
    await AnonymizedRepositoryModel.updateOne(
      { repoId, status: { $in: IN_FLIGHT_STATUSES } },
      {
        $set: {
          status: RepositoryStatus.ERROR,
          statusDate: new Date(),
          statusMessage: message || "preparation_failed",
        },
      }
    )
      .collation({ locale: "en", strength: 2 })
      .exec();
  } catch (e) {
    logger.error("markErrorIfInFlight failed", {
      ...serializeError(e),
      repoId,
    });
  }
}

async function markErrorIfRemoving(repoId: string, message: string) {
  try {
    await AnonymizedRepositoryModel.updateOne(
      { repoId, status: RepositoryStatus.REMOVING },
      {
        $set: {
          status: RepositoryStatus.ERROR,
          statusDate: new Date(),
          statusMessage: message || "removal_failed",
        },
      }
    ).exec();
  } catch (e) {
    logger.error("markErrorIfRemoving failed", {
      ...serializeError(e),
      repoId,
    });
  }
}

/**
 * Recover repositories left in an in-flight status (preparing/queue/download)
 * with no live BullMQ job — typically caused by a worker process crash or
 * server restart during anonymization. Marks them as ERROR so they don't
 * appear stuck forever; the public route can re-queue them on next visit.
 */
export async function recoverStuckPreparing() {
  if (!downloadQueue) return;
  try {
    const stuck = await AnonymizedRepositoryModel.find(
      { status: { $in: IN_FLIGHT_STATUSES } },
      { repoId: 1 }
    ).lean();
    for (const doc of stuck) {
      try {
        const job = await downloadQueue.getJob(`repo-${doc.repoId}`);
        if (job) {
          const state = await job.getState();
          if (state === "active" || state === "waiting" || state === "delayed") {
            continue;
          }
        }
        await markErrorIfInFlight(doc.repoId, "preparation_interrupted");
        logger.info("recovered stuck repo", { repoId: doc.repoId });
      } catch (e) {
        logger.warn("recover failed", {
          ...serializeError(e),
          repoId: doc.repoId,
        });
      }
    }
  } catch (e) {
    logger.error("recoverStuckPreparing failed", serializeError(e));
  }
}

export let cacheQueue: Queue<RepoJobData>;
export let removeQueue: Queue<RepoJobData>;
export let downloadQueue: Queue<RepoJobData>;

type RemovalQueue = Pick<Queue<RepoJobData>, "add" | "getJob">;

/**
 * Add an idempotent repository-removal job. A live job wins; a terminal job
 * with the same stable id is replaced so a retry is not silently discarded.
 */
export async function addRemovalJob(
  repoId: string,
  queue: RemovalQueue = removeQueue
): Promise<boolean> {
  const jobId = `repo-${repoId}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (LIVE_JOB_STATES.has(state)) return false;
    await existing.remove().catch(() => undefined);
  }
  await queue.add(repoId, { repoId }, { ...REMOVAL_JOB_OPTIONS, jobId });
  return true;
}

/**
 * Requeue removals whose database status survived but whose BullMQ job did
 * not, for example after a crash between updating MongoDB and queueing Redis.
 * Failed jobs are replayed only while their removal request is still current.
 */
export async function recoverStuckRemoving() {
  if (!removeQueue) return;
  try {
    // Claim the pending removal before queueing it. A restored repository, or
    // an error from a later operation, must not revive an old deletion request.
    const failedJobs = await removeQueue.getJobs(["failed"]);
    for (const job of failedJobs) {
      const repoId = job.data?.repoId;
      if (!repoId) continue;
      try {
        const pending = await AnonymizedRepositoryModel.findOneAndUpdate(
          {
            repoId,
            $or: [
              { status: RepositoryStatus.REMOVING },
              ...(job.timestamp
                ? [{
                    status: RepositoryStatus.ERROR,
                    $or: [
                      { anonymizeDate: { $lte: new Date(job.timestamp) } },
                      { anonymizeDate: { $exists: false } },
                    ],
                  }]
                : []),
            ],
          },
          { $set: { status: RepositoryStatus.REMOVING } }
        ).collation({ locale: "en", strength: 2 }).exec();
        if (!pending) {
          await job.remove();
          continue;
        }
        await addRemovalJob(repoId);
        logger.info("requeued failed removal", { repoId });
      } catch (e) {
        logger.warn("failed removal recovery failed", {
          ...serializeError(e),
          repoId,
        });
      }
    }

    const stuck = await AnonymizedRepositoryModel.find(
      { status: RepositoryStatus.REMOVING },
      { repoId: 1 }
    ).lean();
    for (const doc of stuck) {
      try {
        const queued = await addRemovalJob(doc.repoId);
        if (queued) {
          logger.info("requeued interrupted removal", { repoId: doc.repoId });
        }
      } catch (e) {
        logger.warn("removal recovery failed", {
          ...serializeError(e),
          repoId: doc.repoId,
        });
        await markErrorIfRemoving(doc.repoId, "removal_interrupted");
      }
    }
  } catch (e) {
    logger.error("recoverStuckRemoving failed", serializeError(e));
  }
}

// avoid to load the queue outside the main server
export function startWorker() {
  const connection = {
    host: config.REDIS_HOSTNAME,
    port: config.REDIS_PORT,
  };

  cacheQueue = new Queue<RepoJobData>("cache removal", {
    connection,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: true,
    },
  });
  removeQueue = new Queue<RepoJobData>("repository removal", {
    connection: {
      host: config.REDIS_HOSTNAME,
      port: config.REDIS_PORT,
    },
    defaultJobOptions: REMOVAL_JOB_OPTIONS,
  });
  downloadQueue = new Queue<RepoJobData>("repository download", {
    connection,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: true,
    },
  });
  const cacheWorker = new Worker<RepoJobData>(
    cacheQueue.name,
    path.resolve("build/queue/processes/removeCache.js"),
    {
      concurrency: 5,
      connection,
      autorun: true,
    }
  );
  cacheWorker.on("completed", async (job) => {
    recordMetric("cache", "completed", (job.finishedOn || Date.now()) - (job.processedOn || job.timestamp));
    await job.remove();
  });
  cacheWorker.on("failed", async (job) => {
    if (job) recordMetric("cache", "failed", Date.now() - (job.processedOn || job.timestamp));
  });
  const removeWorker = new Worker<RepoJobData>(
    removeQueue.name,
    path.resolve("build/queue/processes/removeRepository.js"),
    {
      concurrency: 5,
      connection,
      autorun: true,
    }
  );
  removeWorker.on("completed", async (job) => {
    recordMetric("remove", "completed", (job.finishedOn || Date.now()) - (job.processedOn || job.timestamp));
    await job.remove();
  });
  removeWorker.on("failed", async (job, err) => {
    if (job) recordMetric("remove", "failed", Date.now() - (job.processedOn || job.timestamp));
    const repoId = job?.data?.repoId;
    logger.error("removal failed", {
      ...serializeError(err),
      repoId,
    });
    if (!repoId) return;
    if (job && typeof job.attemptsMade === "number" && job.opts?.attempts) {
      if (job.attemptsMade < job.opts.attempts) return;
    }
    await markErrorIfRemoving(repoId, err?.message || "removal_failed");
  });

  const downloadWorker = new Worker<RepoJobData>(
    downloadQueue.name,
    path.resolve("build/queue/processes/downloadRepository.js"),
    {
      concurrency: 3,
      connection,
      autorun: true,
    }
  );
  if (!downloadWorker.isRunning()) downloadWorker.run();

  downloadWorker.on("active", async (job) => {
    logger.info("download start", { repoId: job.data.repoId });
  });
  downloadWorker.on("completed", async (job) => {
    logger.info("download completed", { repoId: job.data.repoId });
    recordMetric("download", "completed", (job.finishedOn || Date.now()) - (job.processedOn || job.timestamp));
  });
  downloadWorker.on("failed", async (job, err) => {
    if (job) recordMetric("download", "failed", Date.now() - (job.processedOn || job.timestamp));
    const repoId = job?.data?.repoId;
    logger.error("download failed", {
      ...serializeError(err),
      repoId,
    });
    if (!repoId) return;
    if (job && typeof job.attemptsMade === "number" && job.opts?.attempts) {
      if (job.attemptsMade < job.opts.attempts) return;
    }
    await markErrorIfInFlight(repoId, err?.message || "preparation_failed");
  });
}
