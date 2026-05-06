import { SandboxedJob } from "bullmq";
import { getRepository as getRepositoryImport } from "../../server/database";
import { RepoJobData } from "../index";
import { createLogger } from "../../core/logger";

const logger = createLogger("queue:cache");

export default async function (job: SandboxedJob<RepoJobData, void>) {
  const {
    connect,
    getRepository,
  }: {
    connect: () => Promise<void>;
    getRepository: typeof getRepositoryImport;
  } = require("../../server/database");
  try {
    await connect();
    logger.info("removing cache", { repoId: job.data.repoId });
    const repo = await getRepository(job.data.repoId);
    await repo.removeCache();
  } catch {
    // error already handled
  } finally {
    logger.info("cache removed", { repoId: job.data.repoId });
  }
}
