import { createHash } from "crypto";
import { mongo } from "mongoose";

export type IdentityResult = { githubId: string } | { issue: string; halt?: boolean };

/** Only this fixed endpoint receives legacy tokens. Never log request errors or bodies. */
export async function identifyGitHubToken(token: string): Promise<IdentityResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "anonymous-github-owner-recovery",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401) return { issue: "invalid_or_revoked_token" };
      // Stop on forbidden/rate-limited or transient failures instead of hammering GitHub.
      return { issue: `github_http_${response.status}`, halt: true };
    }
    const body = await response.json() as { id?: unknown; type?: unknown };
    if (body.type !== "User" || typeof body.id !== "number" ||
        !Number.isSafeInteger(body.id) || body.id <= 0) {
      return { issue: "unsupported_github_identity" };
    }
    return { githubId: String(body.id) };
  } catch {
    return { issue: "github_request_failed", halt: true };
  } finally {
    clearTimeout(timeout);
  }
}

export interface RecoveryOptions {
  apply?: boolean;
  repositoryId?: mongo.ObjectId;
  identify?: (token: string) => Promise<IdentityResult>;
  pause?: () => Promise<void>;
  report?: (event: { collection: string; id: string; issue?: string;
    ownerId?: string; githubId?: string; action?: string }) => void;
}

export async function recoverRepositoryOwners(db: mongo.Db, options: RecoveryOptions = {}) {
  const repositories = db.collection("anonymizedrepositories");
  const users = db.collection("users");
  const identify = options.identify || identifyGitHubToken;
  const pause = options.pause || (() => new Promise<void>(resolve => setTimeout(resolve, 1000)));
  // Hashes deduplicate HTTP requests without retaining plaintext as cache keys.
  const identities = new Map<string, IdentityResult>();
  const counts = { scanned: 0, candidates: 0, matched: 0, updated: 0, issues: 0, halted: false };
  const report = options.report || (() => {});
  const query = options.repositoryId ? { _id: options.repositoryId } : {};
  for await (const row of repositories.find(query, {
    projection: { owner: 1, "source.accessToken": 1, accessToken: 1 },
  }).batchSize(100)) {
    counts.scanned++;
    if (row.owner && await users.findOne({ _id: row.owner }, { projection: { _id: 1 } })) continue;
    counts.candidates++;
    const event = { collection: "anonymizedrepositories", id: String(row._id) };
    const fail = (issue: string) => { counts.issues++; report({ ...event, issue }); };
    const values: unknown[] = [row.source?.accessToken, row.accessToken];
    if (values.some(value => value != null && typeof value !== "string")) {
      fail("malformed_token"); continue;
    }
    const tokens = [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
    if (!tokens.length) { fail("missing_token"); continue; }
    const ids = new Set<string>();
    let failed = false;
    for (const token of tokens) {
      const hash = createHash("sha256").update(token).digest("hex");
      let identity = identities.get(hash);
      if (!identity) {
        await pause();
        identity = await identify(token);
        if (identities.size >= 10000) identities.clear();
        identities.set(hash, identity);
      }
      if ("issue" in identity) {
        fail(identity.issue);
        counts.halted = !!identity.halt;
        failed = true;
        break;
      }
      ids.add(identity.githubId);
    }
    if (counts.halted) break;
    if (failed) continue;
    if (ids.size !== 1) { fail("conflicting_token_identities"); continue; }
    const githubId = [...ids][0];
    // Match immutable GitHub IDs only. Include historical numeric storage.
    const matches = await users.find({ "externalIDs.github": { $in: [githubId, Number(githubId)] } }, {
      projection: { _id: 1, status: 1 },
    }).limit(2).toArray();
    if (matches.length !== 1) {
      fail(matches.length ? "ambiguous_user" : "user_not_found"); continue;
    }
    const user = matches[0];
    if (user.status === "removed" || user.status === "banned") { fail("disabled_user"); continue; }
    counts.matched++;
    if (options.apply) {
      const unchanged = (value: unknown) => value === undefined ? { $exists: false } : { $eq: value, $exists: true };
      const result = await repositories.updateOne({
        _id: row._id,
        owner: unchanged(row.owner),
        "source.accessToken": unchanged(row.source?.accessToken),
        accessToken: unchanged(row.accessToken),
      }, { $set: { owner: user._id } });
      if (!result.modifiedCount) { fail("repository_changed_retry"); continue; }
      counts.updated++;
    }
    report({ ...event, githubId, ownerId: String(user._id), action: options.apply ? "owner_assigned" : "would_assign_owner" });
  }
  return counts;
}
