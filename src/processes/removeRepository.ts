import { SandboxedJob } from "bullmq";
import Repository from "../Repository";
import { getRepository as getRepositoryImport } from "../database/database";
import { RepositoryStatus } from "../types";
import { trace } from "@opentelemetry/api";
import { Span } from "@opentelemetry/sdk-trace-node";

export default async function (job: SandboxedJob<Repository, void>) {
  const {
    connect,
    getRepository,
  }: {
    connect: () => Promise<void>;
    getRepository: typeof getRepositoryImport;
  } = require("../database/database");
  const span = trace.getTracer("ano-file").startSpan("proc.removeRepository");
  span.setAttribute("repoId", job.data.repoId);
  try {
    await connect();
    console.log(`[QUEUE] ${job.data.repoId} is going to be removed`);
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
      span.recordException(error as Error);
      throw error;
    }
  } catch (error) {
    span.recordException(error as Error);
  } finally {
    console.log(`[QUEUE] ${job.data.repoId} is removed`);
    span.end();
  }
}
