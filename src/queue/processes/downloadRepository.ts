import { SandboxedJob } from "bullmq";
import { config } from "dotenv";
config();
import { getRepository as getRepositoryImport } from "../../server/database";
import { RepositoryStatus } from "../../core/types";
import { RepoJobData } from "../index";

export default async function (job: SandboxedJob<RepoJobData, void>) {
  const {
    connect,
    getRepository,
  }: {
    connect: () => Promise<void>;
    getRepository: typeof getRepositoryImport;
  } = require("../../server/database");
  console.log(`[QUEUE] ${job.data.repoId} is going to be downloaded`);
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
            console.log(
              `[QUEUE] Progress: ${job.data.repoId} ${progress.status}`
            );
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
      console.log(`[QUEUE] ${job.data.repoId} is downloaded`);
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
    console.log(`[QUEUE] ${job.data.repoId} is finished with an error`, error);
    try {
      await repo.updateStatus(
        RepositoryStatus.ERROR,
        error instanceof Error ? error.message : String(error)
      );
    } catch (persistError) {
      console.log(
        `[QUEUE] failed to persist ERROR status for ${job.data.repoId}`,
        persistError
      );
    }
    throw error;
  } finally {
    clearInterval(statusInterval);
  }
}
