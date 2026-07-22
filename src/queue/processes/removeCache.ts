import { SandboxedJob } from "bullmq";
import { getRepository as getRepositoryImport } from "../../server/database";
import { RepoJobData } from "../index";
import { createLogger, serializeError } from "../../core/logger";

const logger = createLogger("queue:cache");

interface Database {
  connect: () => Promise<void>;
  getRepository: typeof getRepositoryImport;
}

export async function processRemoveCache(
  job: SandboxedJob<RepoJobData, void>,
  database?: Database
) {
  const { connect, getRepository }: Database =
    database || require("../../server/database");
  try {
    await connect();
    logger.info("removing cache", { repoId: job.data.repoId });
    const repo = await getRepository(job.data.repoId);
    await repo.removeCache();
    logger.info("cache removed", { repoId: job.data.repoId });
  } catch (error) {
    logger.error("cache removal failed", {
      ...serializeError(error),
      repoId: job.data.repoId,
    });
    throw error;
  }
}

export default processRemoveCache;
