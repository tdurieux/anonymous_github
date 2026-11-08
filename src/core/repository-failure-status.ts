/** Persisted repository failures need the same client status as the original error. */
export function repositoryFailureStatus(code?: string): number {
  switch (code) {
    case "repo_not_found": case "branch_not_found": case "commit_not_found": return 404;
    case "repo_not_accessible": case "repository_not_accessible": return 403;
    case "token_expired": case "not_connected": return 401;
    case "github_rate_limit_exceeded": return 429;
    case "github_unavailable": return 502;
    case "repo_empty": return 409;
    default: return 500;
  }
}
