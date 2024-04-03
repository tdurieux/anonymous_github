import { Queue, Worker } from "bullmq";
import config from "../config";
import Repository from "../core/Repository";
import * as path from "path";

export let cacheQueue: Queue<Repository>;
export let removeQueue: Queue<Repository>;
export let downloadQueue: Queue<Repository>;

// avoid to load the queue outside the main server
export function startWorker() {
  const connection = {
    host: config.REDIS_HOSTNAME,
    port: config.REDIS_PORT,
  };

  cacheQueue = new Queue<Repository>("cache removal", {
    connection,
    defaultJobOptions: {
      removeOnComplete: true,
    },
  });
  removeQueue = new Queue<Repository>("repository removal", {
    connection: {
      host: config.REDIS_HOSTNAME,
      port: config.REDIS_PORT,
    },
    defaultJobOptions: {
      removeOnComplete: true,
    },
  });
  downloadQueue = new Queue<Repository>("repository download", {
    connection,
    defaultJobOptions: {
      removeOnComplete: true,
    },
  });
  const cacheWorker = new Worker<Repository>(
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
  const removeWorker = new Worker<Repository>(
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

  const downloadWorker = new Worker<Repository>(
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
  downloadWorker.on("failed", async (job) => {
    console.log("download repository failed", job.data.repoId);
  });
}
