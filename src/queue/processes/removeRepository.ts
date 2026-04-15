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
      throw error;
    }
  } catch (error) {
    // error already handled
  } finally {
    console.log(`[QUEUE] ${job.data.repoId} is removed`);
  }
}
