import AnonymousError from "../AnonymousError";
import { connect, getRepository } from "../database/database";

export default async function process(job) {
  console.log(`${job.data.repoId} is going to be downloaded`);
  try {
    await connect();
    const repo = await getRepository(job.data.repoId);
    job.progress("get_repo");
    await repo.resetSate();
    job.progress("resetSate");
    try {
      await repo.anonymize();
    } catch (error) {
      await repo.updateStatus("error", error.message);
      throw error;
    }
  } catch (error) {
    if (error instanceof AnonymousError) {
      console.error(
        "[ERROR]",
        error.toString(),
        error.stack.split("\n")[1].trim()
      );
    } else {
      console.error(error);
    }
  } finally {
    console.log(`${job.data.repoId} is downloaded`);
  }
}
