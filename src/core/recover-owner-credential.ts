import { createHash } from "crypto";
import { identifyGitHubToken, IdentityResult } from "./recover-repository-owners";

type Result = { token: string } | { issue: string; halt?: boolean };

/** A resource token is usable only when it authenticates the already recorded owner. */
export function createOwnerCredentialRecovery(identify = identifyGitHubToken) {
  const cache = new Map<string, Promise<IdentityResult>>();
  let gate = Promise.resolve();
  let halted: IdentityResult | undefined;
  const lookup = (token: string) => {
    const hash = createHash("sha256").update(token).digest("hex");
    const cached = cache.get(hash);
    if (cached) return cached;
    const turn = gate;
    gate = turn.then(() => new Promise<void>(resolve => setTimeout(resolve, 250)));
    const request = (async (): Promise<IdentityResult> => {
      await turn;
      if (halted) return halted;
      let identity: IdentityResult;
      try { identity = await identify(token); }
      catch { identity = { issue: "github_request_failed", halt: true }; }
      if ("issue" in identity && identity.halt) halted = identity;
      return identity;
    })();
    // Cache pending requests too, so owners sharing a token share one lookup.
    if (cache.size >= 10000) cache.delete(cache.keys().next().value!);
    cache.set(hash, request);
    return request;
  };
  return async (githubId: unknown, candidates: Iterable<string>): Promise<Result> => {
    const expected = String(githubId ?? "");
    if (!/^[1-9][0-9]*$/.test(expected)) return { issue: "missing_or_invalid_owner_github_id" };
    let selected: string | undefined;
    for (const token of new Set(candidates)) {
      const identity = await lookup(token);
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
