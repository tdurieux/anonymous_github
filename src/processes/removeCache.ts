import { SandboxedJob } from "bullmq";
import Repository from "../Repository";
import { getRepository as getRepositoryImport } from "../database/database";

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
    console.log(
      `[QUEUE] Cache of ${job.data.repoId} is going to be removed...`
    );
    const repo = await getRepository(job.data.repoId);
    try {
      await repo.removeCache();
    } catch (error) {
      throw error;
    }
  } catch (error) {
    console.error(error);
  } finally {
    console.log(`[QUEUE] Cache of ${job.data.repoId} is removed.`);
  }
}
