import * as Queue from "bull";
import config from "../config";
import Repository from "./Repository";
import * as path from "path";

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

removeQueue.process(5, path.resolve("src/processes/removeRepository.ts"));

downloadQueue.process(2, path.resolve("src/processes/downloadRepository.ts"));
