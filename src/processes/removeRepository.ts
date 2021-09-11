import AnonymousError from "../AnonymousError";
import { connect, getRepository } from "../database/database";

export default async function process(job) {
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
    console.log(`${job.data.repoId} is removed`);
  }
}
