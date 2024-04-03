import { trace } from "@opentelemetry/api";
import { SandboxedJob } from "bullmq";
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
