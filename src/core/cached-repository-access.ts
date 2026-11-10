import Repository from "./Repository";
import AnonymousError from "./AnonymousError";
import { isConnected } from "../server/database";
import RepositoryModel from "./model/anonymizedRepositories/anonymizedRepositories.model";
import UserModel from "./model/users/users.model";
import CredentialModel from "./model/credentials/credentials.model";
import config from "../config";
import { APP_PROVIDER, appError } from "./github-app";

/** Local access to an already published snapshot, not permission to fetch upstream. */
export async function canReadCachedRepository(repository: Repository): Promise<boolean> {
  // Unpersisted/test objects must use the existing authorization path.
  if (!isConnected || repository.model.isNew) return false;
  await repository.check();
  const current = await RepositoryModel.findById(repository.model._id).select("owner githubAccess").lean();
  if (!current || String(current.owner) !== repository.owner.id ||
      current.githubAccess?.revision !== repository.model.githubAccess?.revision) {
    throw new AnonymousError("connection_changed", { httpStatus: 409 });
  }
  const user = await UserModel.findById(repository.owner.id).select("status").lean();
  if (!user || user.status === "removed" || user.status === "banned") {
    throw new AnonymousError("not_authorized", { httpStatus: 403 });
  }
  const binding = current.githubAccess;
  const grant = await CredentialModel.findOne({ ownerId: repository.owner.id,
    provider: binding?.kind === "github-app" ? APP_PROVIDER : "github" }).select("revoked").lean();
  if (grant?.revoked) throw new AnonymousError("not_authorized", { httpStatus: 403 });
  if (binding?.kind === "github-app") {
    if (!config.GITHUB_APP_ENABLED || !grant) throw appError();
    // Public visibility and user membership changes are not fully covered by
    // local webhook state. Keep remote authorization for these bindings until
    // a durable per-repository permission reconciliation mechanism exists.
    return false;
  }
  return true;
}
