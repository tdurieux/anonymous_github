import { Queue, Worker } from "bullmq";
import config from "../config";
import AnonymizedRepositoryModel from "../core/model/anonymizedRepositories/anonymizedRepositories.model";
import { RepositoryStatus } from "../core/types";
import * as path from "path";

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
    ).exec();
  } catch (e) {
    console.log("[QUEUE] markErrorIfInFlight error", repoId, e);
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
        const job = await downloadQueue.getJob(doc.repoId);
        if (job) {
          const state = await job.getState();
          if (state === "active" || state === "waiting" || state === "delayed") {
            continue;
          }
        }
        await markErrorIfInFlight(doc.repoId, "preparation_interrupted");
        console.log("[QUEUE] recovered stuck repo", doc.repoId);
      } catch (e) {
        console.log("[QUEUE] recover error for", doc.repoId, e);
      }
    }
  } catch (e) {
    console.log("[QUEUE] recoverStuckPreparing failed", e);
  }
}

export let cacheQueue: Queue<RepoJobData>;
export let removeQueue: Queue<RepoJobData>;
export let downloadQueue: Queue<RepoJobData>;

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
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: true,
    },
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
    await job.remove();
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
    await job.remove();
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
  if (!downloadWorker.isRunning) downloadWorker.run();

  downloadWorker.on("active", async (job) => {
    console.log("[QUEUE] download repository start", job.data.repoId);
  });
  downloadWorker.on("completed", async (job) => {
    console.log("[QUEUE] download repository completed", job.data.repoId);
  });
  downloadWorker.on("failed", async (job, err) => {
    const repoId = job?.data?.repoId;
    console.log(
      "[QUEUE] download repository failed",
      repoId,
      err?.message || err
    );
    if (!repoId) return;
    if (job && typeof job.attemptsMade === "number" && job.opts?.attempts) {
      if (job.attemptsMade < job.opts.attempts) return;
    }
    await markErrorIfInFlight(repoId, err?.message || "preparation_failed");
  });
}
