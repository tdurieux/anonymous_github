import { SandboxedJob } from "bullmq";
import { config } from "dotenv";
config();
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
  console.log(`[QUEUE] ${job.data.repoId} is going to be downloaded`);
  try {
    await connect();
    const repo = await getRepository(job.data.repoId);
    job.updateProgress({ status: "get_repo" });
    await repo.resetSate(RepositoryStatus.PREPARING, "");
    job.updateProgress({ status: "resetSate" });
    try {
      await repo.anonymize();
    } catch (error) {
      await repo.updateStatus(RepositoryStatus.ERROR, error.message);
      throw error;
    }
  } catch (error) {
    console.error(error);
  } finally {
    console.log(`[QUEUE] ${job.data.repoId} is downloaded`);
  }
}
