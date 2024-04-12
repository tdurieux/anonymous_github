import { Exception, trace } from "@opentelemetry/api";
import { SandboxedJob } from "bullmq";
import { config } from "dotenv";
config();
import Repository from "../../core/Repository";
import { getRepository as getRepositoryImport } from "../../server/database";
import { RepositoryStatus } from "../../core/types";

export default async function (job: SandboxedJob<Repository, void>) {
  const {
    connect,
    getRepository,
  }: {
    connect: () => Promise<void>;
    getRepository: typeof getRepositoryImport;
  } = require("../../server/database");
  const span = trace.getTracer("ano-file").startSpan("proc.downloadRepository");
  span.setAttribute("repoId", job.data.repoId);
  console.log(`[QUEUE] ${job.data.repoId} is going to be downloaded`);
  let statusInterval: any = null;
  await connect();
  const repo = await getRepository(job.data.repoId);
  try {
    let progress: any = null;
    statusInterval = setInterval(async () => {
      try {
        if (
          repo.status == RepositoryStatus.READY ||
          repo.status == RepositoryStatus.ERROR
        ) {
          return clearInterval(statusInterval);
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
      } catch (_) {
        // ignore error
      }
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
      await repo.updateStatus(RepositoryStatus.READY, "");
      console.log(`[QUEUE] ${job.data.repoId} is downloaded`);
    } catch (error) {
      updateProgress({ status: "error" });
      if (error instanceof Error) {
        span.recordException(error as Exception);
        await repo.updateStatus(RepositoryStatus.ERROR, error.message);
      } else if (typeof error === "string") {
        await repo.updateStatus(RepositoryStatus.ERROR, error);
        span.recordException(error);
      }
      throw error;
    }
  } catch (error: any) {
    clearInterval(statusInterval);
    span.recordException(error as Exception);
    console.log(`[QUEUE] ${job.data.repoId} is finished with an error`, error);
    setTimeout(async () => {
      // delay to avoid double saving
      try {
        await repo.updateStatus(RepositoryStatus.ERROR, error.message);
      } catch (ignore) {}
    }, 400);
  } finally {
    clearInterval(statusInterval);
    span.end();
  }
}
