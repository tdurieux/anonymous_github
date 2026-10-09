import { createHash } from "crypto";
import AnonymousError from "../AnonymousError";
import { ExpiringMap } from "../expiring-map";
import { octokit, waitForTokenGate, RateLimitDelayError } from "../GitHubUtils";
import { GitHubBaseData } from "./GitHubBase";

type Miss = "file_not_found" | "repo_not_found" | "commit_not_found";
const results = new ExpiringMap<Miss>(2048);
const pending = new Map<string, Promise<Miss>>();

function missKey(data: GitHubBaseData, token: string): string {
  return createHash("sha256").update(JSON.stringify([
    data.repoId, data.organization, data.repoName, data.commit, data.cacheGeneration, data.cacheRevision, token,
  ])).digest("hex");
}

export function cachedContentMiss(data: GitHubBaseData, token: string): Miss | undefined {
  return results.get(missKey(data, token));
}

/** A raw 404 can mean a missing file, lost repository access, or a removed revision. */
export async function classifyContentMiss(data: GitHubBaseData, token: string): Promise<Miss> {
  const key = missKey(data, token);
  const cached = results.get(key);
  if (cached) return cached;
  const active = pending.get(key);
  if (active) return active;
  if (pending.size >= 64) throw new AnonymousError("cache_busy", { httpStatus: 503 });
  const probe = (async (): Promise<Miss> => {
    const oct = octokit(token);
    const options = { owner: data.organization, repo: data.repoName, request: { timeout: 15_000 } };
    try {
      await waitForTokenGate(token);
      await oct.repos.get(options);
    } catch (error) {
      if ((error as { status?: number }).status === 404) return "repo_not_found";
      throw probeError(error);
    }
    try {
      await waitForTokenGate(token);
      // Only check that the revision resolves; do not download a potentially
      // large commit diff just to classify a missing file.
      await oct.repos.getCommit({ ...options, ref: data.commit || "HEAD", mediaType: { format: "sha" } });
    } catch (error) {
      const upstream = error as { status?: number; response?: { data?: { message?: string } } };
      if (upstream.status === 404 || upstream.status === 409 || (upstream.status === 422 &&
          /^No commit found for SHA\b/.test(upstream.response?.data?.message || ""))) return "commit_not_found";
      throw probeError(error);
    }
    return "file_not_found";
  })().then(result => { results.set(key, result, 30_000); return result; });
  pending.set(key, probe);
  try { return await probe; }
  finally { if (pending.get(key) === probe) pending.delete(key); }
}

function probeError(error: unknown): AnonymousError {
  if (error instanceof AnonymousError) return error;
  if (error instanceof RateLimitDelayError) return new AnonymousError("github_rate_limit_exceeded", { httpStatus: 429, cause: error });
  const status = (error as { status?: number }).status;
  return new AnonymousError(status === 401 ? "token_expired" : status === 403 ? "repo_not_accessible" : "github_unavailable", {
    httpStatus: status === 401 || status === 403 ? status : 502,
    cause: error as Error,
  });
}
