import { octokit } from "./GitHubUtils";
import AnonymousError from "./AnonymousError";
import { classifyByName, isTextFile } from "./anonymize-utils";

/** Enough for the picker; larger repositories fall back to patterns. */
export const SOURCE_FILE_LIST_LIMIT = 20000;

export interface SourceFileList {
  files: string[];
  /** Known binary files (images, PDFs, archives): listed in the preview's tree, never redacted. */
  binaryFiles: string[];
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
  const binaryFiles: string[] = [];
  for (const entry of data.tree) {
    if (entry.type !== "blob" || !entry.path || entry.path === ".gitmodules") continue;
    const list = classifyByName(entry.path) === false ? binaryFiles : files;
    if (files.length + binaryFiles.length === SOURCE_FILE_LIST_LIMIT) {
      return { files: files.sort(), binaryFiles: binaryFiles.sort(), truncated: true };
    }
    list.push(entry.path);
  }
  return { files: files.sort(), binaryFiles: binaryFiles.sort(), truncated: !!data.truncated };
}

/** Largest file the anonymize preview reads from GitHub (the contents API's inline limit). */
export const SOURCE_FILE_PREVIEW_LIMIT = 1024 * 1024;

/**
 * A repository-relative path as the tree API returns it: no leading or
 * trailing slash, no empty, "." or ".." segment, no backslash or control
 * character.
 */
export function isSafeSourcePath(path: unknown): path is string {
  if (typeof path !== "string" || !path || path.length > 4096) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f]/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export type SourceFileContent =
  | { binary: false; content: string; size: number }
  | { binary: true; size: number };

/**
 * One file of a commit, for the anonymize preview's file viewer. The text is
 * returned as is: the caller redacts it through /api/anonymize-preview, like
 * the README. Binary files are reported, not sent.
 */
export async function sourceFileContent(opt: {
  owner: string;
  repo: string;
  commit: string;
  path: string;
  accessToken: string;
}): Promise<SourceFileContent> {
  if (!isSafeSourcePath(opt.path)) throw new AnonymousError("invalid_path", { httpStatus: 400 });
  let data;
  try {
    ({ data } = await octokit(opt.accessToken).repos.getContent({
      owner: opt.owner,
      repo: opt.repo,
      path: opt.path,
      ref: opt.commit,
      mediaType: { format: "object" },
    }));
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 422) {
      throw new AnonymousError("file_not_found", { httpStatus: 404, cause: error as Error });
    }
    throw error;
  }
  const file = data as { type?: string; size?: number; content?: string; encoding?: string };
  if (Array.isArray(data) || file.type !== "file") {
    throw new AnonymousError("file_not_found", { httpStatus: 404 });
  }
  const size = file.size || 0;
  if (classifyByName(opt.path) === false) return { binary: true, size };
  if (size > SOURCE_FILE_PREVIEW_LIMIT || (size > 0 && file.encoding === "none")) {
    throw new AnonymousError("file_too_big", { httpStatus: 413 });
  }
  const buffer = Buffer.from(file.content || "", file.encoding === "base64" ? "base64" : "utf8");
  if (buffer.length && !isTextFile(opt.path, buffer)) return { binary: true, size };
  return { binary: false, content: buffer.toString("utf8"), size };
}
