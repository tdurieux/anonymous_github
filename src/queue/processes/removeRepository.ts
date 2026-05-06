import { SandboxedJob } from "bullmq";
import { getRepository as getRepositoryImport } from "../../server/database";
import { RepositoryStatus } from "../../core/types";
import { RepoJobData } from "../index";
import { createLogger } from "../../core/logger";

const logger = createLogger("queue:remove");

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
    logger.info("removing repository", { repoId: job.data.repoId });
    const repo = await getRepository(job.data.repoId);
    await repo.updateStatus(RepositoryStatus.REMOVING, "");
    try {
      await repo.remove();
    } catch (error) {
      if (error instanceof Error) {
        await repo.updateStatus(RepositoryStatus.ERROR, error.message);
      } else if (typeof error === "string") {
        await repo.updateStatus(RepositoryStatus.ERROR, error);
      }
      throw error;
    }
  } catch {
    // error already handled
  } finally {
    logger.info("repository removed", { repoId: job.data.repoId });
  }
}
