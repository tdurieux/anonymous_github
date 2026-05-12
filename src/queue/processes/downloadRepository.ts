import { SandboxedJob } from "bullmq";
import { config } from "dotenv";
config();
import { getRepository as getRepositoryImport } from "../../server/database";
import { RepositoryStatus } from "../../core/types";
import { RepoJobData } from "../index";
import { createLogger, serializeError } from "../../core/logger";
import { RateLimitDelayError, getRedisGateResetAt, setRedisGateFromWorker, getToken } from "../../core/GitHubUtils";
import { DelayedError } from "bullmq";

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
  const token = await getToken(repo);
  const tokenKey = token.slice(-8);

  const gateResetAt = await getRedisGateResetAt(tokenKey);
  if (gateResetAt > 0) {
    const delaySec = Math.ceil((gateResetAt - Date.now()) / 1000);
    logger.info("rate limit gate active, delaying job before work", {
      repoId: job.data.repoId,
      delaySec,
      resetAt: new Date(gateResetAt).toISOString(),
    });
    await repo.updateStatus(
      RepositoryStatus.QUEUE,
      `rate_limited:${gateResetAt}`
    );
    await job.moveToDelayed(gateResetAt);
    throw new DelayedError();
  }
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

      // Rate-limited: delay the job and free the worker slot
      const isRateDelay = error instanceof RateLimitDelayError;
      const isRateError = !isRateDelay && error instanceof Error &&
        (error.message === "github_rate_limit_exceeded" || error.message.includes("rate limit"));
      if (isRateDelay || isRateError) {
        const resetAt = isRateDelay
          ? (error as RateLimitDelayError).resetAt
          : Date.now() + 60_000; // fallback: retry in 1 min
        const delaySec = Math.ceil(Math.max(0, resetAt - Date.now()) / 1000);
        logger.info("rate-limited, delaying job", {
          repoId: job.data.repoId,
          delaySec,
          resetAt: new Date(resetAt).toISOString(),
        });
        await setRedisGateFromWorker(tokenKey, resetAt);
        await repo.updateStatus(
          RepositoryStatus.QUEUE,
          `rate_limited:${resetAt}`
        );
        await job.moveToDelayed(resetAt);
        throw new DelayedError();
      }

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
    if (error instanceof DelayedError || (error instanceof Error && error.name === "DelayedError")) {
      throw error;
    }
    logger.error("finished with error", {
      ...serializeError(error),
      repoId: job.data.repoId,
      url: `/api/repo/${job.data.repoId}`,
    });
    try {
      await repo.updateStatus(
        RepositoryStatus.ERROR,
        error instanceof Error ? error.message : String(error)
      );
    } catch (persistError) {
      logger.error("failed to persist ERROR status", {
        ...serializeError(persistError),
        repoId: job.data.repoId,
        url: `/api/repo/${job.data.repoId}`,
      });
    }
    throw error;
  } finally {
    clearInterval(statusInterval);
  }
}
