import * as Queue from "bull";
import config from "../config";
import AnonymousError from "./AnonymousError";
import { getRepository } from "./database/database";
import Repository from "./Repository";

export const removeQueue = new Queue<Repository>("repository removal", {
  redis: {
    host: config.REDIS_HOSTNAME,
    port: config.REDIS_PORT,
  },
});
removeQueue.on("completed", async (job) => {
  await job.remove();
});
export const downloadQueue = new Queue<Repository>("repository download", {
  redis: {
    host: config.REDIS_HOSTNAME,
    port: config.REDIS_PORT,
  },
});
downloadQueue.on("completed", async (job) => {
  await job.remove();
});

removeQueue.process(5, async (job) => {
  console.log(`${job.data.repoId} is going to be removed`);
  try {
    const repo = await getRepository(job.data.repoId);
    await repo.remove();
  } catch (error) {
    if (error instanceof AnonymousError) {
      console.error(
        "[ERROR]",
        error.toString(),
        error.stack.split("\n")[1].trim()
      );
    } else {
      console.error(error);
    }
  } finally {
    console.log(`${job.data.repoId} is removed`);
  }
});

downloadQueue.process(2, async (job) => {
  console.log(`${job.data.repoId} is going to be downloaded`);
  try {
    const repo = await getRepository(job.data.repoId);
    job.progress("get_repo");
    await repo.resetSate();
    job.progress("resetSate");
    await repo.anonymize();
  } catch (error) {
    if (error instanceof AnonymousError) {
      console.error(
        "[ERROR]",
        error.toString(),
        error.stack.split("\n")[1].trim()
      );
    } else {
      console.error(error);
    }
  } finally {
    console.log(`${job.data.repoId} is downloaded`);
  }
});
