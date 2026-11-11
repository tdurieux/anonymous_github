import * as express from "express";
import { getRepo, getUser, handleError, isOwnerCoauthorOrAdmin } from "./route-utils";
import AnonymousError from "../../core/AnonymousError";
import { normalizePreserveFiles } from "../../core/preserve-files";
import RepoModel from "../../core/model/anonymizedRepositories/anonymizedRepositories.model";

const router = express.Router();
const toggles = ["update", "image", "pdf", "notebook", "link"];

/** Only in-place anonymization settings; never accept source or connection input. */
export function maintenanceSettings(body: unknown): Record<string, unknown> {
  const invalid = () => new AnonymousError("invalid_settings", { httpStatus: 400 });
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const entries = Object.entries(body);
  if (!entries.length) throw invalid();
  const updates: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (key === "terms") {
      if (!Array.isArray(value) || value.length > 1000 ||
        !value.every(t => typeof t === "string" && t.length > 0 && t.length <= 1000)) throw invalid();
    } else if (key === "preserveFiles") {
      const patterns = normalizePreserveFiles(value);
      if (!Array.isArray(value) || patterns === null) throw invalid();
      updates["options.preserveFiles"] = patterns;
      continue;
    } else if (!toggles.includes(key) || typeof value !== "boolean") throw invalid();
    updates[`options.${key}`] = value;
  }
  return updates;
}

router.route("/repositories/:repoId")
  .all((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); })
  .get(async (req, res) => {
    try {
      const user = await getUser(req);
      const repo = await getRepo(req, res, { nocheck: true });
      if (!repo) return;
      isOwnerCoauthorOrAdmin(repo, user);
      // Read saved metadata without refreshing GitHub credentials or content.
      res.json({ repoId: repo.repoId, status: repo.status, statusMessage: repo.model.statusMessage,
        statusDate: repo.model.statusDate, settingsSavedAt: repo.model.settingsSavedAt,
        source: { branch: repo.model.source.branch, commit: repo.model.source.commit },
        options: repo.model.options });
    } catch (error) { handleError(error, res, req); }
  })
  .patch(async (req, res) => {
    try {
      const user = await getUser(req);
      const repo = await getRepo(req, res, { nocheck: true });
      if (!repo) return;
      isOwnerCoauthorOrAdmin(repo, user);
      if (!["ready", "error"].includes(repo.status || "")) throw new AnonymousError("invalid_status", { httpStatus: 409 });
      repo.assertNotArchived();
      const updates = maintenanceSettings(req.body);
      const settingsSavedAt = new Date();
      const saved = await RepoModel.updateOne({ _id: repo.model._id, status: repo.model.status,
        statusDate: repo.model.statusDate,
        settingsSavedAt: repo.model.settingsSavedAt || { $exists: false } },
      { $set: { ...updates, settingsSavedAt } }).exec();
      if (!saved.matchedCount) throw new AnonymousError("invalid_status", { httpStatus: 409 });
      res.json({ repoId: repo.repoId, status: repo.status, settingsSavedAt });
    } catch (error) { handleError(error, res, req); }
  });
export default router;
