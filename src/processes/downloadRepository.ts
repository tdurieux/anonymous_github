import { SandboxedJob } from "bullmq";
import { config } from "dotenv";
config();
import Repository from "../Repository";

export default async function (job: SandboxedJob<Repository, void>) {
  const { connect, getRepository } = require("../database/database");
  console.log(`${job.data.repoId} is going to be downloaded`);
  try {
    await connect();
    const repo = await getRepository(job.data.repoId);
    job.updateProgress({ status: "get_repo" });
    await repo.resetSate("preparing");
    job.updateProgress({ status: "resetSate" });
    try {
      await repo.anonymize();
    } catch (error) {
      await repo.updateStatus("error", error.message);
      throw error;
    }
  } catch (error) {
    console.error(error);
  } finally {
    console.log(`${job.data.repoId} is downloaded`);
  }
}
