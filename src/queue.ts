import { Queue, Worker } from "bullmq";
import config from "../config";
import Repository from "./Repository";
import * as path from "path";

export let removeQueue: Queue<Repository>;
export let downloadQueue: Queue<Repository>;

// avoid to load the queue outside the main server
export function startWorker() {
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
    connection: {
      host: config.REDIS_HOSTNAME,
      port: config.REDIS_PORT,
    },
    defaultJobOptions: {
      removeOnComplete: true,
    },
  });
  const removeWorker = new Worker<Repository>(
    removeQueue.name,
    path.resolve("dist/src/processes/removeRepository.js"),
    //removeRepository,
    {
      concurrency: 5,
      connection: {
        host: config.REDIS_HOSTNAME,
        port: config.REDIS_PORT,
      },
      autorun: true,

    }
  );
  removeWorker.on("error", async (error) => {
    console.log(error);
  });
  removeWorker.on("completed", async (job) => {
    await job.remove();
  });

  const downloadWorker = new Worker<Repository>(
    downloadQueue.name,
    path.resolve("dist/src/processes/downloadRepository.js"),
    // downloadRepository,
    {
      concurrency: 3,
      connection: {
        host: config.REDIS_HOSTNAME,
        port: config.REDIS_PORT,
      },
      autorun: true
    }
  );
  if (!downloadWorker.isRunning) downloadWorker.run();

  downloadWorker.on("active", async (job) => {
    console.log("active", job.data.repoId);
  });
  downloadWorker.on("completed", async (job) => {
    console.log("completed", job.data.repoId);
  });
  downloadWorker.on("failed", async (job) => {
    console.log("failed", job.data.repoId);
  });
  downloadWorker.on("closing", async (error) => {
    console.log("closing", error);
  });
  downloadWorker.on("error", async (error) => {
    console.log(error);
  });
}
