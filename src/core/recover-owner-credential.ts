import { createHash } from "crypto";
import { identifyGitHubToken, IdentityResult } from "./recover-repository-owners";

type Result = { token: string } | { issue: string; halt?: boolean };

/** A resource token is usable only when it authenticates the already recorded owner. */
export function createOwnerCredentialRecovery(identify = identifyGitHubToken) {
  const cache = new Map<string, IdentityResult>();
  let nextRequest = 0;
  return async (githubId: unknown, candidates: Iterable<string>): Promise<Result> => {
    const expected = String(githubId ?? "");
    if (!/^[1-9][0-9]*$/.test(expected)) return { issue: "missing_or_invalid_owner_github_id" };
    let selected: string | undefined;
    for (const token of new Set(candidates)) {
      const hash = createHash("sha256").update(token).digest("hex");
      let identity = cache.get(hash);
      if (!identity) {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, nextRequest - Date.now())));
        nextRequest = Date.now() + 250;
        try { identity = await identify(token); }
        catch { return { issue: "github_request_failed", halt: true }; }
        if (cache.size >= 10000) cache.delete(cache.keys().next().value!);
        cache.set(hash, identity);
      }
      if ("issue" in identity) {
        if (identity.issue === "invalid_or_revoked_token") continue;
        return identity;
      }
      if (identity.githubId !== expected) continue;
      if (selected) return { issue: "multiple_valid_owner_tokens" };
      selected = token;
    }
    return selected ? { token: selected } : { issue: "no_valid_owner_token" };
  };
}
