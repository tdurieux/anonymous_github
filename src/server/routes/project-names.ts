import { isConnected } from "../database";
import DashboardName from "../../core/model/dashboard-name";
import { invalidateDashboardNames } from "./dashboard-names";
import { createHash } from "crypto";
import AnonymousError from "../../core/AnonymousError";
import User from "../../core/User";
import UserModel from "../../core/model/users/users.model";

export function projectNameKey(type: string, id: string): string {
  return createHash("sha256").update(`${type}:${id}`).digest("hex");
}

// Names belong to the user's dashboard, rather than the shared artifact.
export async function saveProjectName(user: User, input: unknown): Promise<string> {
  const body = input as { type?: unknown; id?: unknown; name?: unknown } | null;
  if (!body || typeof body.type !== "string" || !["repo", "pr", "gist"].includes(body.type)
      || typeof body.id !== "string" || !body.id || body.id.length > 250
      || typeof body.name !== "string" || body.name.trim().length > 100
      || Array.from(body.name).some(character => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })) {
    throw new AnonymousError("invalid_project_name", { httpStatus: 400 });
  }
  const type = String(body.type);
  const records = type === "repo" ? await user.getRepositories()
    : type === "pr" ? await user.getPullRequests() : await user.getGists();
  const field = type === "repo" ? "repoId" : type === "pr" ? "pullRequestId" : "gistId";
  if (!records.some(record => (record as unknown as Record<string, unknown>)[field] === body.id)) {
    throw new AnonymousError("not_authorized", { httpStatus: 403 });
  }
  const key = projectNameKey(type, body.id);
  const name = body.name.trim();
  const path = `projectNames.${key}`;
  await UserModel.updateOne({ _id: user.model._id }, name
    ? { $set: { [path]: name } } : { $unset: { [path]: "" } });
  invalidateDashboardNames();
  if (name) user.model.set(path, name);
  else user.model.projectNames?.delete(key);
  if (isConnected && name) await DashboardName.updateOne({ owner: user.model._id, type, artifactId: body.id },
    { $set: { name } }, { upsert: true });
  else if (isConnected) await DashboardName.deleteOne({ owner: user.model._id, type, artifactId: body.id });
  return name;
}
