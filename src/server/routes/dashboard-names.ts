import { isConnected } from "../database";
import { AsyncCache } from "../../core/async-cache";
import DashboardName from "../../core/model/dashboard-name";
import Repo from "../../core/model/anonymizedRepositories/anonymizedRepositories.model";
import PR from "../../core/model/anonymizedPullRequests/anonymizedPullRequests.model";
import Gist from "../../core/model/anonymizedGists/anonymizedGists.model";
import User from "../../core/User";
import { projectNameKey } from "./project-names";
const backfills = new AsyncCache<void>(5 * 60_000, 64);
export function invalidateDashboardNames() { backfills.clear(); }
/** Backfill legacy private names using ID-only cursors, never artifact bodies. */
export function ensureDashboardNames(user: User) {
  if (!isConnected) return Promise.resolve();
  return backfills.get(user.id, async () => {
    // The user map is authoritative, including after an interrupted dual write.
    const existing = DashboardName.find({ owner: user.model._id }).lean().cursor();
    try {
      let batch: Parameters<typeof DashboardName.bulkWrite>[0] = [];
      for await (const row of existing) {
        const name = user.model.projectNames?.get(projectNameKey(row.type, row.artifactId));
        batch.push(name ? { updateOne: { filter: { _id: row._id }, update: { $set: { name } } } }
          : { deleteOne: { filter: { _id: row._id } } });
        if (batch.length === 250) { await DashboardName.bulkWrite(batch); batch = []; }
      }
      if (batch.length) await DashboardName.bulkWrite(batch);
    } finally { await existing.close(); }
    if (!user.model.projectNames?.size) return;
    const sources = [
      { type: "repo", cursor: Repo.find(user.repositoryMembership()).select("repoId").lean().cursor(), field: "repoId" },
      { type: "pr", cursor: PR.find({ owner: user.id }).select("pullRequestId").lean().cursor(), field: "pullRequestId" },
      { type: "gist", cursor: Gist.find({ owner: user.id }).select("gistId").lean().cursor(), field: "gistId" },
    ];
    for (const { type, cursor, field } of sources) {
      try {
        let batch: Parameters<typeof DashboardName.bulkWrite>[0] = [];
        for await (const row of cursor) {
          const id = String((row as unknown as Record<string, unknown>)[field] || "");
          const name = user.model.projectNames!.get(projectNameKey(type, id));
          if (!name) continue;
          batch.push({ updateOne: { filter: { owner: user.model._id, type, artifactId: id },
            update: { $set: { name } }, upsert: true } });
          if (batch.length === 250) { await DashboardName.bulkWrite(batch); batch = []; }
        }
        if (batch.length) await DashboardName.bulkWrite(batch);
      } finally { await cursor.close(); }
    }
  });
}
