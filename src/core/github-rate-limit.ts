// Octokit RequestError shape (subset we care about for rate-limit detection).
export interface OctokitRequestErrorLike {
  status?: number;
  httpStatus?: number;
  message?: string;
  response?: {
    statusCode?: number;
    headers?: Record<string, string | undefined>;
  };
}

/** Detect GitHub primary and secondary rate limits in API and stream errors. */
export function isGitHubRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as OctokitRequestErrorLike;
  const msg = (e.message ?? "").toLowerCase();
  // Primary limits return 403 with "x-ratelimit-remaining: 0"; secondary
  // limits return 403 (sometimes 429) with "secondary rate limit" in the
  // body. Match on either signal so we catch both.
  const status = e.status ?? e.response?.statusCode ?? e.httpStatus ?? 0;
  if (status !== 403 && status !== 429) return false;
  if (msg.includes("rate limit") || msg.includes("abuse")) return true;
  const remaining = e.response?.headers?.["x-ratelimit-remaining"];
  return remaining === "0";
}

