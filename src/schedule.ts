import * as schedule from "node-schedule";
import Conference from "./Conference";
import ConferenceModel from "./database/conference/conferences.model";

export function conferenceStatusCheck() {
  // check every 6 hours the status of the conference
  const job = schedule.scheduleJob("0 */6 * * *", async () => {
    (await ConferenceModel.find({ status: { $eq: "ready" } })).forEach(
      async (data) => {
        const conference = new Conference(data);
        if (conference.isExpired() && conference.status == "ready") {
          await conference.expire();
        }
      }
    );
  });
}
