import { Readable } from "stream";

import AnonymizedFile from "../AnonymizedFile";
import { SourceBase } from "./Source";
import { IFile } from "../model/files/files.types";
import { octokit } from "../GitHubUtils";
import { isConnected } from "../../server/database";
import RepositoryModel from "../model/repositories/repositories.model";
import AnonymizedRepositoryModel from "../model/anonymizedRepositories/anonymizedRepositories.model";

export interface GitHubBaseData {
  getToken: () => string | Promise<string>;
  repoId: string;
  organization: string;
  repoName: string;
  commit: string;
}

export default abstract class GitHubBase implements SourceBase {
  abstract type: "GitHubDownload" | "GitHubStream" | "Zip";
  accessToken: string | undefined;

  constructor(readonly data: GitHubBaseData) {}

  abstract getFileContent(
    file: AnonymizedFile,
    progress?: (status: string) => void
  ): Promise<Readable>;

  abstract getFiles(progress?: (status: string) => void): Promise<IFile[]>;
}

/**
 * On a 404 from a commit/tree/zip lookup, probe `repos.get` to determine
 * whether the repository itself is gone, was renamed, or only the commit is
 * missing. When a rename is detected (via the cached numeric GitHub repo id
 * on `RepositoryModel.externalId`), the model's `name` is updated in place so
 * subsequent lookups succeed.
 */
export async function classifyGitHubMissError(
  err: unknown,
  data: GitHubBaseData
): Promise<"repo_not_found" | "commit_not_found" | "repo_renamed"> {
  const status = (err as { status?: number }).status;
  if (status !== 404) return "repo_not_found";
  const oct = octokit(await data.getToken());
  try {
    await oct.repos.get({
      owner: data.organization,
      repo: data.repoName,
    });
    return "commit_not_found";
  } catch {
    // Repo no longer exists at owner/repo. Try to recover via the cached
    // numeric GitHub id — if the repo was renamed, GET /repositories/{id}
    // resolves to its new full_name. See #409.
    if (!isConnected) return "repo_not_found";
    const dbModel = await RepositoryModel.findOne({
      name: data.organization + "/" + data.repoName,
    });
    const ghId =
      typeof dbModel?.externalId === "string" &&
      dbModel.externalId.startsWith("gh_")
        ? dbModel.externalId.slice(3)
        : null;
    if (!dbModel || !ghId) return "repo_not_found";
    try {
      const r = await oct.request("GET /repositories/{id}", { id: ghId });
      const newName = (r?.data as { full_name?: string } | undefined)
        ?.full_name;
      if (newName && newName !== dbModel.name) {
        const oldName = dbModel.name;
        dbModel.name = newName;
        await dbModel.save();
        // Propagate the rename to every anonymized repo that referenced
        // the old source name, so subsequent lookups (admin diagnostic,
        // streaming, download, update cron) all hit the correct GitHub
        // location without the user having to recreate the configuration.
        await AnonymizedRepositoryModel.updateMany(
          { "source.repositoryName": oldName },
          { $set: { "source.repositoryName": newName } }
        );
        data.organization = newName.split("/")[0];
        data.repoName = newName.split("/")[1];
        return "repo_renamed";
      }
      return "repo_not_found";
    } catch {
      return "repo_not_found";
    }
  }
}
