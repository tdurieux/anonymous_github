import { octokit, waitForTokenGate } from "../GitHubUtils";
import AnonymousError from "../AnonymousError";
import { IFile, UpstreamFile } from "../model/files/files.types";
import { GitHubBaseData } from "./GitHubBase";

export const MAX_SUBMODULES = 20;
export const MAX_SUBMODULE_ENTRIES = 10000;
export interface SubmoduleMount extends Omit<UpstreamFile, "path"> { path: string; }

export function safeRepositoryPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    !value.includes("\\") && !value.includes("\0") &&
    value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

export function validUpstream(value: unknown): value is UpstreamFile {
  if (!value || typeof value !== "object") return false;
  const v = value as UpstreamFile;
  return typeof v.organization === "string" && /^[a-zA-Z0-9-]+$/.test(v.organization) &&
    typeof v.repoName === "string" && /^[a-zA-Z0-9_.-]+$/.test(v.repoName) && ![".", ".."].includes(v.repoName) &&
    typeof v.commit === "string" && /^[a-f0-9]{40}$/.test(v.commit) && safeRepositoryPath(v.path);
}

export function submoduleRepository(url: unknown, parent: GitHubBaseData): { organization: string; repoName: string } | null {
  if (typeof url !== "string") return null;
  const normalized = url.replace(/^git@github\.com:/, "https://github.com/").replace(/^ssh:\/\/git@github\.com\//, "https://github.com/").replace(/^git:\/\/github\.com\//, "https://github.com/");
  try {
    const parsed = new URL(normalized, url.startsWith("./") || url.startsWith("../")
      ? `https://github.com/${parent.organization}/${parent.repoName}/` : undefined);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const parts = parsed.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "").split("/");
    if (parts.length !== 3) return null;
    const candidate = { organization: parts[1], repoName: parts[2], commit: "a".repeat(40), path: "file" };
    return validUpstream(candidate) ? { organization: candidate.organization, repoName: candidate.repoName } : null;
  } catch { return null; }
}

/** Resolve only direct public GitHub dependencies. Never send the parent token to a child. */
export async function expandSubmodules(files: IFile[], data: GitHubBaseData): Promise<IFile[]> {
  const output = files.filter(file => file.name !== ".gitmodules");
  const modules = output.filter(file => file.submodule);
  let remaining = MAX_SUBMODULE_ENTRIES;
  for (const [index, mount] of modules.entries()) {
    if (index >= MAX_SUBMODULES) { mount.submodule = "limit"; continue; }
    const mountPath = [mount.path, mount.name].filter(Boolean).join("/");
    if (!safeRepositoryPath(mountPath) || !mount.sha || !/^[a-f0-9]{40}$/.test(mount.sha)) continue;
    const token = await data.getToken();
    await waitForTokenGate(token);
    try {
      const response = await octokit(token).repos.getContent({
        owner: data.organization, repo: data.repoName, path: mountPath, ref: data.commit,
      });
      const metadata = response.data as { submodule_git_url?: string; sha?: string };
      const repository = submoduleRepository(metadata.submodule_git_url, data);
      if (!repository || metadata.sha !== mount.sha) continue;
      // An unauthenticated request proves public access, even for an owner whose
      // parent token can also read private dependencies. No credentials cross repos.
      await waitForTokenGate("");
      const child = await octokit("").git.getTree({
        owner: repository.organization, repo: repository.repoName, tree_sha: mount.sha, recursive: "1",
      });
      if (child.data.truncated || child.data.tree.length > remaining) { mount.submodule = "limit"; continue; }
      const entries = child.data.tree;
      if (entries.some(entry => !safeRepositoryPath(entry.path))) { mount.submodule = "unsupported"; continue; }
      remaining -= entries.length;
      mount.submodule = "included";
      mount.upstream = { ...repository, commit: mount.sha, path: "" };
      for (const entry of entries) {
        const relative = entry.path!;
        if (relative.split("/").pop() === ".gitmodules") continue;
        const fullPath = `${mountPath}/${relative}`;
        const slash = fullPath.lastIndexOf("/");
        output.push({
          repoId: data.repoId, name: fullPath.slice(slash + 1), path: fullPath.slice(0, slash),
          sha: entry.sha, size: entry.size,
          ...(entry.type === "commit" ? { submodule: "nested" as const } : {}),
          ...(entry.type === "blob" ? { upstream: { ...repository, commit: mount.sha, path: relative } } : {}),
        });
      }
    } catch (error) {
      if ((error as { status?: number }).status === 404) { mount.submodule = "unavailable"; continue; }
      // Do not persist a partial tree on rate limits, outages or credential errors.
      throw error;
    }
  }
  return output;
}

export function validateMounts(value: unknown): SubmoduleMount[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SUBMODULES || value.some(mount => !validUpstream(mount))) {
    throw new AnonymousError("invalid_request", { httpStatus: 400 });
  }
  const paths = value.map(mount => mount.path as string);
  if (paths.some((path, i) => paths.some((other, j) => i !== j && (path === other || path.startsWith(other + "/"))))) {
    throw new AnonymousError("invalid_request", { httpStatus: 400 });
  }
  return value;
}
