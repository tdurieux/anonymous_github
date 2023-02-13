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
      if (error instanceof Error) {
        await repo.updateStatus(RepositoryStatus.ERROR, error.message);
      } else if (typeof error === "string") {
        await repo.updateStatus(RepositoryStatus.ERROR, error);
      }
      throw error;
    }
  } catch (error) {
    console.error(error);
  } finally {
    console.log(`[QUEUE] ${job.data.repoId} is downloaded`);
  }
}
