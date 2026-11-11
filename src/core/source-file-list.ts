import { octokit } from "./GitHubUtils";
import AnonymousError from "./AnonymousError";
import { classifyByName } from "./anonymize-utils";

/** Enough for the picker; larger repositories fall back to patterns. */
export const SOURCE_FILE_LIST_LIMIT = 20000;

export interface SourceFileList {
  files: string[];
  truncated: boolean;
}

/**
 * Text files of a commit, read from GitHub's recursive tree API. Used by the
 * "Leave files unredacted" picker (#941) before the repository is downloaded.
 * Known binary files are dropped: their content is never redacted anyway.
 */
export async function sourceFileList(opt: {
  owner: string;
  repo: string;
  commit: string;
  accessToken: string;
}): Promise<SourceFileList> {
  const oct = octokit(opt.accessToken);
  let data;
  try {
    // The commit field accepts abbreviated hashes; the tree API needs a full one.
    let commit = opt.commit;
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
      commit = (await oct.repos.getCommit({ owner: opt.owner, repo: opt.repo, ref: commit })).data.sha;
    }
    ({ data } = await oct.git.getTree({
      owner: opt.owner,
      repo: opt.repo,
      tree_sha: commit,
      recursive: "true",
    }));
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 409 || status === 422) {
      throw new AnonymousError("repo_not_found", { httpStatus: 404, cause: error as Error });
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of data.tree) {
    if (entry.type !== "blob" || !entry.path) continue;
    if (entry.path === ".gitmodules" || classifyByName(entry.path) === false) continue;
    if (files.length === SOURCE_FILE_LIST_LIMIT) return { files: files.sort(), truncated: true };
    files.push(entry.path);
  }
  return { files: files.sort(), truncated: !!data.truncated };
}
