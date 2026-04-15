import { SandboxedJob } from "bullmq";
import Repository from "../../core/Repository";
import { getRepository as getRepositoryImport } from "../../server/database";

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
    console.log(
      `[QUEUE] Cache of ${job.data.repoId} is going to be removed...`
    );
    const repo = await getRepository(job.data.repoId);
    await repo.removeCache();
  } catch {
    // error already handled
  } finally {
    console.log(`[QUEUE] Cache of ${job.data.repoId} is removed.`);
  }
}
