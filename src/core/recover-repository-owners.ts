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
  archiveUnrecoverable?: boolean;
  archiveAllOwnerless?: boolean;
  concurrency?: number;
  repositoryId?: mongo.ObjectId;
  identify?: (token: string) => Promise<IdentityResult>;
  pause?: () => Promise<void>;
  deleteCache?: (repoId: string) => Promise<void>;
  report?: (event: { collection: string; id: string; issue?: string;
    ownerId?: string; githubId?: string; action?: string; reason?: string }) => void;
}

export async function recoverRepositoryOwners(db: mongo.Db, options: RecoveryOptions = {}) {
  const concurrency = options.concurrency ?? 5;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("Concurrency must be an integer between 1 and 32");
  }
  const repositories = db.collection("anonymizedrepositories");
  const users = db.collection("users");
  const identify = options.identify || identifyGitHubToken;
  const deleteCache = options.deleteCache || (async (repoId: string) => {
    const storage = (await import("./storage")).default;
    await storage.rm(repoId);
  });
  // Share one pacing gate across workers. At most four new HTTP requests/second.
  let gate: Promise<void> = Promise.resolve();
  const pause = options.pause || (() => {
    const next = gate.then(() => new Promise<void>(resolve => setTimeout(resolve, 250)));
    gate = next;
    return next;
  });
  const counts = { scanned: 0, candidates: 0, matched: 0, updated: 0,
    archiveCandidates: 0, archived: 0, cacheDeleted: 0, alreadyArchived: 0, issues: 0, halted: false };
  const report = options.report || (() => {});
  // In-flight lookups are shared too; parallel workers never request the same token twice.
  const identities = new Map<string, Promise<IdentityResult>>();
  const lookup = (token: string) => {
    const hash = createHash("sha256").update(token).digest("hex");
    let result = identities.get(hash);
    if (!result) {
      result = (async () => {
        await pause();
        if (counts.halted) return { issue: "scan_halted", halt: true };
        const identity = await identify(token);
        if ("issue" in identity && identity.halt) counts.halted = true;
        return identity;
      })();
      identities.set(hash, result);
      // Evict settled entries only, retaining deduplication of requests in flight.
      void result.then(() => {
        if (identities.size > 10000) identities.delete(hash);
      }, () => {});
    }
    return result;
  };
  const processRow = async (row: mongo.WithId<mongo.Document>) => {
    counts.scanned++;
    if (row.owner && await users.findOne({ _id: row.owner }, { projection: { _id: 1 } })) return;
    const event = { collection: "anonymizedrepositories", id: String(row._id) };
    const fail = (issue: string) => { counts.issues++; report({ ...event, issue }); };
    const unchanged = (value: unknown) => value === undefined ? { $exists: false } : { $eq: value, $exists: true };
    const original = { _id: row._id, repoId: unchanged(row.repoId), owner: unchanged(row.owner), status: unchanged(row.status),
      "source.accessToken": unchanged(row.source?.accessToken), accessToken: unchanged(row.accessToken) };
    // Legacy IDs can contain spaces. Keep their exact spelling for storage lookup.
    // Separators/control characters stay forbidden, as do empty and dot-only IDs.
    const safeRepoId = () => typeof row.repoId === "string" &&
      /^[a-zA-Z0-9_. -]+$/.test(row.repoId) &&
      !["", ".", ".."].includes(row.repoId.trim());
    const cleanup = async () => {
      if (!safeRepoId()) { fail("unsafe_or_missing_repo_id"); return; }
      try {
        await deleteCache(row.repoId);
        const result = await repositories.updateOne({ _id: row._id, status: "archived", archiveCachePending: true }, {
          $set: { archiveCachePending: false, isReseted: true },
        });
        if (!result.modifiedCount) { fail("repository_changed_retry"); return; }
        counts.cacheDeleted++;
        report({ ...event, action: "archive_cache_deleted" });
      } catch {
        fail("archive_cache_cleanup_failed");
      }
    };
    if (row.status === "archived" && row.source?.accessToken === undefined && row.accessToken === undefined) {
      counts.alreadyArchived++;
      if (row.archiveCachePending && (options.archiveUnrecoverable || options.archiveAllOwnerless)) {
        if (options.apply) await cleanup();
        else report({ ...event, action: "would_delete_archive_cache" });
      }
      return;
    }
    counts.candidates++;
    const archive = async (reason: string) => {
      if (!options.archiveUnrecoverable && !options.archiveAllOwnerless) { fail(reason); return; }
      if (!safeRepoId()) { fail("unsafe_or_missing_repo_id"); return; }
      counts.archiveCandidates++;
      if (options.apply) {
        const now = new Date();
        const result = await repositories.updateOne(original, {
          $set: { status: "archived", statusDate: now, archivedAt: now,
            archiveReason: reason, archiveCachePending: true, "options.update": false },
          $unset: { "source.accessToken": "", accessToken: "" },
        });
        if (!result.modifiedCount) { fail("repository_changed_retry"); return; }
        counts.archived++;
        report({ ...event, reason, action: "archived" });
        await cleanup();
      } else report({ ...event, reason, action: "would_archive" });
    };
    if (options.archiveAllOwnerless) { await archive("missing_owner"); return; }
    const values: unknown[] = [row.source?.accessToken, row.accessToken];
    if (values.some(value => value != null && typeof value !== "string")) { fail("malformed_token"); return; }
    const tokens = [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
    if (!tokens.length) { await archive("missing_token"); return; }
    const ids = new Set<string>();
    let invalidTokens = 0;
    for (const token of tokens) {
      const identity = await lookup(token);
      if ("issue" in identity) {
        if (identity.issue === "invalid_or_revoked_token") { invalidTokens++; continue; }
        fail(identity.issue);
        return;
      }
      ids.add(identity.githubId);
    }
    if (invalidTokens === tokens.length) { await archive("invalid_or_revoked_token"); return; }
    if (invalidTokens) { fail("mixed_token_validity"); return; }
    if (ids.size !== 1) { fail("conflicting_token_identities"); return; }
    const githubId = [...ids][0];
    const matches = await users.find({ "externalIDs.github": { $in: [githubId, Number(githubId)] } }, {
      projection: { _id: 1, status: 1 },
    }).limit(2).toArray();
    if (matches.length !== 1) { fail(matches.length ? "ambiguous_user" : "user_not_found"); return; }
    const user = matches[0];
    if (user.status === "removed" || user.status === "banned") { fail("disabled_user"); return; }
    counts.matched++;
    if (options.apply) {
      const result = await repositories.updateOne(original, { $set: { owner: user._id } });
      if (!result.modifiedCount) { fail("repository_changed_retry"); return; }
      counts.updated++;
    }
    report({ ...event, githubId, ownerId: String(user._id), action: options.apply ? "owner_assigned" : "would_assign_owner" });
  };
  const pending = new Set<Promise<void>>();
  let failed = false;
  const cursor = repositories.find(options.repositoryId ? { _id: options.repositoryId } : {}, {
    projection: { owner: 1, repoId: 1, status: 1, archiveCachePending: 1, "source.accessToken": 1, accessToken: 1 },
  }).batchSize(100);
  try {
    for await (const row of cursor) {
      if (counts.halted || failed) break;
      const task = processRow(row).catch(() => { failed = true; counts.halted = true; });
      pending.add(task);
      void task.then(() => pending.delete(task));
      if (pending.size >= concurrency) await Promise.race(pending);
    }
  } finally {
    await Promise.all(pending);
  }
  if (failed) throw new Error("Owner recovery database operation failed");
  return counts;
}
