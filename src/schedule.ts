import * as schedule from "node-schedule";
import Conference from "./Conference";
import AnonymizedRepositoryModel from "./database/anonymizedRepositories/anonymizedRepositories.model";
import ConferenceModel from "./database/conference/conferences.model";
import Repository from "./Repository";

export function conferenceStatusCheck() {
  // check every 6 hours the status of the conferences
  const job = schedule.scheduleJob("0 */6 * * *", async () => {
    (await ConferenceModel.find({ status: { $eq: "ready" } })).forEach(
      async (data) => {
        const conference = new Conference(data);
        if (conference.isExpired() && conference.status == "ready") {
          try {
            await conference.expire();
          } catch (error) {
            console.error(error);
          }
        }
      }
    );
  });
}

export function repositoryStatusCheck() {
  // check every 6 hours the status of the repositories
  const job = schedule.scheduleJob("0 */6 * * *", async () => {
    console.log("[schedule] Check repository status and unused repositories");
    (
      await AnonymizedRepositoryModel.find({ status: { $eq: "ready" } })
    ).forEach((data) => {
      const repo = new Repository(data);
      try {
        repo.check();
      } catch (error) {
        console.log(`Repository ${repo.repoId} is expired`);
      }
      const sixMonthAgo = new Date();
      sixMonthAgo.setMonth(sixMonthAgo.getMonth() - 6);

      if (repo.model.lastView < sixMonthAgo) {
        repo.removeCache().then(() => {
          console.log(
            `Repository ${repo.repoId} not visited for 6 months remove the cached files`
          );
        });
      }
    });
  });
}
