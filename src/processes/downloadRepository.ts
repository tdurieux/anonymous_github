import { SandboxedJob } from "bullmq";
import { config } from "dotenv";
config();
import Repository from "../Repository";
import { getRepository as getRepositoryImport } from "../database/database";
import { RepositoryStatus } from "../types";
import { Exception, trace } from "@opentelemetry/api";

export default async function (job: SandboxedJob<Repository, void>) {
  const {
    connect,
    getRepository,
  }: {
    connect: () => Promise<void>;
    getRepository: typeof getRepositoryImport;
  } = require("../database/database");
  const span = trace.getTracer("ano-file").startSpan("proc.downloadRepository");
  span.setAttribute("repoId", job.data.repoId);
  console.log(`[QUEUE] ${job.data.repoId} is going to be downloaded`);
  try {
    await connect();
    const repo = await getRepository(job.data.repoId);
    job.updateProgress({ status: "get_repo" });
    try {
      job.updateProgress({ status: "resetSate" });
      await repo.resetSate(RepositoryStatus.PREPARING, "");
      job.updateProgress({ status: "download" });
      await repo.anonymize();
      console.log(`[QUEUE] ${job.data.repoId} is downloaded`);
    } catch (error) {
      job.updateProgress({ status: "error" });
      if (error instanceof Error) {
        span.recordException(error as Exception);
        await repo.updateStatus(RepositoryStatus.ERROR, error.message);
      } else if (typeof error === "string") {
        await repo.updateStatus(RepositoryStatus.ERROR, error);
        span.recordException(error);
      }
      throw error;
    }
  } catch (error) {
    span.recordException(error as Exception);
    console.log(`[QUEUE] ${job.data.repoId} is finished with an error`);
  } finally {
    span.end();
  }
}
