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
  let repo: Awaited<ReturnType<typeof getRepositoryImport>> | undefined;
  try {
    await connect();
    logger.info("removing repository", { repoId: job.data.repoId });
    repo = await getRepository(job.data.repoId);
    await repo.updateStatus(RepositoryStatus.REMOVING, "");
    await repo.remove();
    logger.info("repository removed", { repoId: job.data.repoId });
  } catch (error) {
    if (repo) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "removal_failed";
      try {
        await repo.updateStatus(RepositoryStatus.ERROR, message);
      } catch (statusError) {
        logger.error("failed to record repository removal error", {
          ...serializeError(statusError),
          repoId: job.data.repoId,
        });
      }
    }
    logger.error("repository removal failed", {
      ...serializeError(error),
      repoId: job.data.repoId,
    });
    throw error;
  }
}

/**
 * BullMQ calls sandbox processors with (job, lockToken). Keep that transport
 * signature separate from the injectable worker function used by tests.
 */
export function createRemoveRepositoryProcessor(database?: Database) {
  return async (
    job: SandboxedJob<RepoJobData, void>,
    _lockToken?: string
  ) => processRemoveRepository(job, database);
}

export default createRemoveRepositoryProcessor();
