import { SandboxedJob } from "bullmq";
import { getRepository as getRepositoryImport } from "../../server/database";
import { RepositoryStatus } from "../../core/types";
import { RepoJobData } from "../index";
import { createLogger, serializeError } from "../../core/logger";

const logger = createLogger("queue:remove");

interface Database {
  connect: () => Promise<void>;
  getRepository: typeof getRepositoryImport;
}

export async function processRemoveRepository(
  job: SandboxedJob<RepoJobData, void>,
  database?: Database
) {
  const { connect, getRepository }: Database =
    database || require("../../server/database");
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
    logger.info("repository removed", { repoId: job.data.repoId });
  } catch (error) {
    logger.error("repository removal failed", {
      ...serializeError(error),
      repoId: job.data.repoId,
    });
    throw error;
  }
}

export default processRemoveRepository;
