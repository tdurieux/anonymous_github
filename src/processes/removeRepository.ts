import { SandboxedJob } from "bullmq";
import Repository from "../Repository";

export default async function (job: SandboxedJob<Repository, void>) {
  const { connect, getRepository } = require("../database/database");
  try {
    await connect();
    console.log(`${job.data.repoId} is going to be removed`);
    const repo = await getRepository(job.data.repoId);
    try {
      await repo.remove();
    } catch (error) {
      await repo.updateStatus("error", error.message);
      throw error;
    }
  } catch (error) {
    console.error(error);
  } finally {
    console.log(`${job.data.repoId} is removed`);
  }
}
