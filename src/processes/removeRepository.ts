import { SandboxedJob } from "bullmq";
import Repository from "../Repository";
import { getRepository as getRepositoryImport } from "../database/database";
import { RepositoryStatus } from "../types";

export default async function (job: SandboxedJob<Repository, void>) {
  const {
    connect,
    getRepository,
  }: {
    connect: () => Promise<void>;
    getRepository: typeof getRepositoryImport;
  } = require("../database/database");
  try {
    await connect();
    console.log(`[QUEUE] ${job.data.repoId} is going to be removed`);
    const repo = await getRepository(job.data.repoId);
    await repo.updateStatus(RepositoryStatus.REMOVING, "");
    try {
      await repo.remove();
    } catch (error) {
      await repo.updateStatus(RepositoryStatus.ERROR, error.message);
      throw error;
    }
  } catch (error) {
    console.error(error);
  } finally {
    console.log(`[QUEUE] ${job.data.repoId} is removed`);
  }
}
