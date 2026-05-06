import { SandboxedJob } from "bullmq";
import { config } from "dotenv";
config();
import { getRepository as getRepositoryImport } from "../../server/database";
import { RepositoryStatus } from "../../core/types";
import { RepoJobData } from "../index";
import { createLogger, serializeError } from "../../core/logger";

const logger = createLogger("queue:download");

export default async function (job: SandboxedJob<RepoJobData, void>) {
  const {
    connect,
    getRepository,
  }: {
    connect: () => Promise<void>;
    getRepository: typeof getRepositoryImport;
  } = require("../../server/database");
  logger.info("queued for download", { repoId: job.data.repoId });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let statusInterval: any = null;
  await connect();
  const repo = await getRepository(job.data.repoId);
  let tickPromise: Promise<void> | null = null;
  try {
    let progress: { status: string } | null = null;
    statusInterval = setInterval(() => {
      if (tickPromise) return;
      tickPromise = (async () => {
        try {
          if (
            repo.status == RepositoryStatus.READY ||
            repo.status == RepositoryStatus.ERROR
          ) {
            clearInterval(statusInterval);
            return;
          }
          if (
            progress &&
            repo.status &&
            repo.model.statusMessage !== progress?.status
          ) {
            logger.debug("progress", {
              repoId: job.data.repoId,
              status: progress.status,
            });
            await repo.updateStatus(repo.status, progress?.status || "");
          }
        } catch {
          // ignore error
        } finally {
          tickPromise = null;
        }
      })();
    }, 1000);
    function updateProgress(obj: { status: string } | string) {
      const o = typeof obj === "string" ? { status: obj } : obj;
      progress = o;
      job.updateProgress(o);
    }
    try {
      await repo.resetSate(RepositoryStatus.PREPARING, "");
      await repo.anonymize(updateProgress);
      clearInterval(statusInterval);
      if (tickPromise) await tickPromise;
      await repo.updateStatus(RepositoryStatus.READY, "");
      logger.info("downloaded", { repoId: job.data.repoId });
    } catch (error) {
      clearInterval(statusInterval);
      if (tickPromise) await tickPromise;
      updateProgress({ status: "error" });
      if (error instanceof Error) {
        await repo.updateStatus(RepositoryStatus.ERROR, error.message);
      } else if (typeof error === "string") {
        await repo.updateStatus(RepositoryStatus.ERROR, error);
      }
      throw error;
    }
  } catch (error: unknown) {
    clearInterval(statusInterval);
    if (tickPromise) {
      try {
        await tickPromise;
      } catch { /* ignored */ }
    }
    logger.error("finished with error", {
      repoId: job.data.repoId,
      err: serializeError(error),
    });
    try {
      await repo.updateStatus(
        RepositoryStatus.ERROR,
        error instanceof Error ? error.message : String(error)
      );
    } catch (persistError) {
      logger.error("failed to persist ERROR status", {
        repoId: job.data.repoId,
        err: serializeError(persistError),
      });
    }
    throw error;
  } finally {
    clearInterval(statusInterval);
  }
}
