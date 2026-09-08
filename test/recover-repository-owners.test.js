const { setTimeout } = require("timers");
const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { recoverRepositoryOwners, identifyGitHubToken } = require("../src/core/recover-repository-owners");

function fixture(rows, users = []) {
  const writes = [];
  const db = { collection: name => name === "users" ? {
    findOne: async query => users.find(user => user._id === query._id) || null,
    find: query => ({ limit: () => ({ toArray: async () => users.filter(user =>
      query["externalIDs.github"].$in.includes(user.githubId)).slice(0, 2) }) }),
  } : {
    find: () => ({ batchSize: () => ({ async *[Symbol.asyncIterator]() { yield* rows; } }) }),
    updateOne: async (filter, update) => { writes.push({ filter, update }); return { modifiedCount: 1 }; },
  } };
  const events = [];
  const options = { pause: async () => {}, report: event => events.push(event), identify: async () => ({ githubId: "42" }) };
  return { db, writes, events, options };
}

describe("repository owner recovery", () => {
  const user = { _id: "user-42", githubId: "42", status: "active" };
  it("dry run reports the ID match without writing or exposing tokens", async () => {
    const f = fixture([{ _id: "repo", source: { accessToken: "secret" } }], [user]);
    const result = await recoverRepositoryOwners(f.db, f.options);
    expect(result.matched).to.equal(1);
    expect(result.updated).to.equal(0);
    expect(f.writes).to.have.length(0);
    expect(f.events[0].ownerId).to.equal(user._id);
    expect(JSON.stringify(f.events)).not.to.include("secret");
  });
  it("assigns only owner and guards the original owner and both token locations", async () => {
    const f = fixture([{ _id: "repo", owner: null, source: { accessToken: "secret" } }], [user]);
    const result = await recoverRepositoryOwners(f.db, { ...f.options, apply: true });
    expect(result.updated).to.equal(1);
    expect(f.writes[0].update).to.deep.equal({ $set: { owner: user._id } });
    expect(f.writes[0].filter.owner).to.deep.equal({ $eq: null, $exists: true });
    expect(f.writes[0].filter["source.accessToken"]).to.deep.equal({ $eq: "secret", $exists: true });
    expect(f.writes[0].filter.accessToken).to.deep.equal({ $exists: false });
  });
  it("skips repositories with existing owners and recovers dangling references", async () => {
    const f = fixture([{ _id: "keep", owner: user._id }, { _id: "recover", owner: "deleted-user", accessToken: "secret" }], [user]);
    const result = await recoverRepositoryOwners(f.db, { ...f.options, apply: true });
    expect(result.candidates).to.equal(1);
    expect(f.writes[0].filter._id).to.equal("recover");
  });
  it("deduplicates GitHub calls for shared tokens", async () => {
    const f = fixture([{ _id: "a", accessToken: "same" }, { _id: "b", accessToken: "same" }], [user]);
    let calls = 0;
    await recoverRepositoryOwners(f.db, { ...f.options, identify: async () => { calls++; return { githubId: "42" }; } });
    expect(calls).to.equal(1);
    expect(f.events).to.have.length(2);
  });
  it("refuses tokens belonging to different accounts", async () => {
    const f = fixture([{ _id: "repo", accessToken: "first", source: { accessToken: "second" } }], [user]);
    await recoverRepositoryOwners(f.db, { ...f.options, apply: true, identify: async token => ({ githubId: token === "first" ? "42" : "43" }) });
    expect(f.events[0].issue).to.equal("conflicting_token_identities");
    expect(f.writes).to.have.length(0);
  });
  it("rejects unknown, ambiguous, and disabled users", async () => {
    for (const [users, issue] of [[[], "user_not_found"], [[user, { ...user, _id: "duplicate" }], "ambiguous_user"], [[{ ...user, status: "banned" }], "disabled_user"], [[{ ...user, status: "removed" }], "disabled_user"]]) {
      const f = fixture([{ _id: "repo", accessToken: "secret" }], users);
      await recoverRepositoryOwners(f.db, { ...f.options, apply: true });
      expect(f.events[0].issue).to.equal(issue);
      expect(f.writes).to.have.length(0);
    }
  });
  it("supports legacy numeric GitHub IDs", async () => {
    const f = fixture([{ _id: "repo", accessToken: "secret" }], [{ ...user, githubId: 42 }]);
    expect((await recoverRepositoryOwners(f.db, f.options)).matched).to.equal(1);
  });
  it("reports missing and malformed tokens", async () => {
    const f = fixture([{ _id: "missing" }, { _id: "malformed", accessToken: { bad: true } }], [user]);
    await recoverRepositoryOwners(f.db, f.options);
    expect(f.events.map(e => e.issue)).to.deep.equal(["missing_token", "malformed_token"]);
  });
  it("stops immediately on rate limits", async () => {
    const f = fixture([{ _id: "a", accessToken: "first" }, { _id: "b", accessToken: "second" }], [user]);
    const result = await recoverRepositoryOwners(f.db, { ...f.options, identify: async () => ({ issue: "github_http_429", halt: true }) });
    expect(result.halted).to.equal(true);
    expect(result.scanned).to.equal(1);
    expect(f.writes).to.have.length(0);
  });
  it("does not overwrite concurrent repository changes", async () => {
    const f = fixture([{ _id: "repo", accessToken: "secret" }], [user]);
    const original = f.db.collection;
    f.db.collection = name => name === "users" ? original(name) : { ...original(name), updateOne: async () => ({ modifiedCount: 0 }) };
    const result = await recoverRepositoryOwners(f.db, { ...f.options, apply: true });
    expect(result.updated).to.equal(0);
    expect(f.events[0].issue).to.equal("repository_changed_retry");
  });
});

describe("GitHub token identification", () => {
  let original;
  beforeEach(() => { original = global.fetch; });
  afterEach(() => { global.fetch = original; });
  it("sends the token only to the fixed authenticated-user endpoint", async () => {
    global.fetch = async (url, options) => {
      expect(url).to.equal("https://api.github.com/user");
      expect(options.headers.Authorization).to.equal("Bearer secret");
      expect(options.redirect).to.equal("error");
      return { ok: true, json: async () => ({ id: 42, type: "User" }) };
    };
    expect(await identifyGitHubToken("secret")).to.deep.equal({ githubId: "42" });
  });
  it("distinguishes revoked tokens from failures requiring a stop", async () => {
    for (const status of [401, 403, 429, 503]) {
      global.fetch = async () => ({ ok: false, status });
      const result = await identifyGitHubToken("secret");
      expect(!!result.halt).to.equal(status !== 401);
    }
  });
  it("suppresses request errors that could contain credentials", async () => {
    global.fetch = async () => { throw new Error("Bearer secret"); };
    expect(await identifyGitHubToken("secret")).to.deep.equal({ issue: "github_request_failed", halt: true });
  });
  it("rejects invalid identities", async () => {
    for (const body of [{ id: 42, type: "Bot" }, { id: "42", type: "User" }, { id: -1, type: "User" }]) {
      global.fetch = async () => ({ ok: true, json: async () => body });
      expect(await identifyGitHubToken("secret")).to.deep.equal({ issue: "unsupported_github_identity" });
    }
  });
});

describe("archive ownerless repositories", () => {
  it("previews all ownerless records without GitHub calls or storage deletion", async () => {
    const f = fixture([{ _id: "repo", repoId: "legacy-repo", accessToken: "admin-token" }]);
    const result = await recoverRepositoryOwners(f.db, { ...f.options, archiveAllOwnerless: true,
      identify: async () => { throw new Error("must not call GitHub"); },
      deleteCache: async () => { throw new Error("must not delete in dry run"); } });
    expect(result.archiveCandidates).to.equal(1);
    expect(result.archived).to.equal(0);
    expect(result.issues).to.equal(0);
    expect(f.writes).to.have.length(0);
    expect(f.events[0]).to.include({ action: "would_archive", reason: "missing_owner" });
  });
  it("marks archived before deleting cache and retains database records", async () => {
    const f = fixture([{ _id: "repo", repoId: "legacy-repo", source: { accessToken: "admin-token" } }]);
    const deleted = [];
    const result = await recoverRepositoryOwners(f.db, { ...f.options, apply: true, archiveAllOwnerless: true,
      identify: async () => { throw new Error("must not call GitHub"); },
      deleteCache: async id => {
        expect(f.writes[0].update.$set.status).to.equal("archived");
        expect(f.writes[0].update.$set.archiveCachePending).to.equal(true);
        deleted.push(id);
      } });
    expect(result.archived).to.equal(1);
    expect(result.cacheDeleted).to.equal(1);
    expect(deleted).to.deep.equal(["legacy-repo"]);
    expect(f.writes[0].update.$unset).to.deep.equal({ "source.accessToken": "", accessToken: "" });
    expect(f.writes[0].update.$set["options.update"]).to.equal(false);
    expect(f.writes[1].update.$set.archiveCachePending).to.equal(false);
  });
  it("never archives a repository with an existing owner", async () => {
    const f = fixture([{ _id: "repo", owner: "admin", repoId: "repo" }], [{ _id: "admin" }]);
    const result = await recoverRepositoryOwners(f.db, { ...f.options, apply: true, archiveAllOwnerless: true });
    expect(result.archiveCandidates).to.equal(0);
    expect(f.writes).to.have.length(0);
  });
  it("keeps failed cache cleanup pending and resumes without calling GitHub", async () => {
    const f = fixture([{ _id: "repo", repoId: "legacy-repo" }]);
    const result = await recoverRepositoryOwners(f.db, { ...f.options, apply: true, archiveAllOwnerless: true,
      deleteCache: async () => { throw new Error("storage unavailable"); } });
    expect(result.issues).to.equal(1);
    expect(f.writes).to.have.length(1);
    const resumed = fixture([{ _id: "repo", repoId: "legacy-repo", status: "archived", archiveCachePending: true }]);
    const retry = await recoverRepositoryOwners(resumed.db, { ...resumed.options, apply: true, archiveAllOwnerless: true,
      identify: async () => { throw new Error("must not call GitHub"); }, deleteCache: async () => {} });
    expect(retry.cacheDeleted).to.equal(1);
    expect(retry.issues).to.equal(0);
  });
  it("skips completed archives on reruns", async () => {
    const f = fixture([{ _id: "repo", repoId: "legacy-repo", status: "archived", archiveCachePending: false }]);
    expect((await recoverRepositoryOwners(f.db, { ...f.options, apply: true, archiveAllOwnerless: true })).alreadyArchived).to.equal(1);
    expect(f.writes).to.have.length(0);
  });
  it("rejects unsafe storage paths before changing the record", async () => {
    for (const repoId of [undefined, "", "   ", ".", "..", ".. ", "../other", "a/b", "a\\b", "/etc", "repo\n", "repo\0"]) {
      const f = fixture([{ _id: "repo", repoId }]);
      await recoverRepositoryOwners(f.db, { ...f.options, apply: true, archiveAllOwnerless: true });
      expect(f.events[0].issue).to.equal("unsafe_or_missing_repo_id");
      expect(f.writes).to.have.length(0);
    }
  });
  it("does not delete files after a conditional update loses a race", async () => {
    const f = fixture([{ _id: "repo", repoId: "legacy-repo" }]);
    const original = f.db.collection;
    f.db.collection = name => name === "users" ? original(name) : { ...original(name), updateOne: async () => ({ modifiedCount: 0 }) };
    const result = await recoverRepositoryOwners(f.db, { ...f.options, apply: true, archiveAllOwnerless: true,
      deleteCache: async () => { throw new Error("must not delete"); } });
    expect(result.cacheDeleted).to.equal(0);
    expect(f.events[0].issue).to.equal("repository_changed_retry");
  });
  it("archives only missing or entirely revoked tokens in selective mode", async () => {
    const f = fixture([{ _id: "missing", repoId: "missing" }, { _id: "revoked", repoId: "revoked", accessToken: "bad" },
      { _id: "mixed", repoId: "mixed", accessToken: "bad", source: { accessToken: "good" } }]);
    const result = await recoverRepositoryOwners(f.db, { ...f.options, archiveUnrecoverable: true,
      identify: async token => token === "bad" ? { issue: "invalid_or_revoked_token" } : { githubId: "42" } });
    expect(result.archiveCandidates).to.equal(2);
    expect(f.events.find(e => e.id === "mixed").issue).to.equal("mixed_token_validity");
  });
  it("runs work concurrently within the configured bound", async () => {
    const f = fixture(Array.from({ length: 9 }, (_, i) => ({ _id: String(i), accessToken: `token-${i}` })), [{ _id: "owner", githubId: "42" }]);
    let active = 0, maximum = 0;
    await recoverRepositoryOwners(f.db, { ...f.options, concurrency: 3, identify: async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--; return { githubId: "42" };
    } });
    expect(maximum).to.equal(3);
    expect(f.events).to.have.length(9);
  });
  it("validates concurrency", async () => {
    const f = fixture([]);
    for (const concurrency of [0, 33, 1.5]) {
      try { await recoverRepositoryOwners(f.db, { ...f.options, concurrency }); throw new Error("expected failure"); }
      catch (error) { expect(error.message).to.equal("Concurrency must be an integer between 1 and 32"); }
    }
  });
});

describe("archived repository access", () => {
  const Repository = require("../src/core/Repository").default;
  const UserModel = require("../src/core/model/users/users.model").default;
  function archived() {
    return new Repository({ owner: new UserModel()._id, repoId: "archived-test", status: "archived",
      source: {}, options: { update: false }, size: { file: 9, storage: 123 } });
  }
  it("rejects public access and source fetching without querying storage", async () => {
    const repo = archived();
    for (const action of [() => repo.check(), () => repo.getToken(), () => repo.files(), () => repo.updateIfNeeded({ force: true }), () => repo.anonymize(), () => repo.resetSate()]) {
      try { await action(); throw new Error("expected archive rejection"); }
      catch (error) { expect(error.message).to.equal("repository_archived"); }
    }
    expect(() => repo.source).to.throw("repository_archived");
    expect(() => repo.zip()).to.throw("repository_archived");
    expect(repo.model.size).to.deep.equal({ file: 9, storage: 123 });
  });
  it("cannot reactivate an archive through a status update or old cache job", async () => {
    const repo = archived();
    try { await repo.updateStatus("ready"); throw new Error("expected rejection"); }
    catch (error) { expect(error.message).to.equal("repository_archived"); }
    await repo.removeCache();
    expect(repo.status).to.equal("archived");
    expect(repo.model.size.file).to.equal(9);
  });
  it("deletes only the target cache directory using filesystem storage", async () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const config = require("../src/config").default;
    const FileSystem = require("../src/core/storage/FileSystem").default;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-cache-test-"));
    const before = config.FOLDER;
    try {
      config.FOLDER = root;
      for (const id of ["Paccmann Polymer", "keep-sibling"]) {
        fs.mkdirSync(path.join(root, id, "original"), { recursive: true });
        fs.writeFileSync(path.join(root, id, "original", "file.txt"), "cached content");
      }
      const f = fixture([{ _id: "repo", repoId: "Paccmann Polymer" }]);
      await recoverRepositoryOwners(f.db, { ...f.options, apply: true, archiveAllOwnerless: true,
        deleteCache: id => new FileSystem().rm(id) });
      expect(fs.existsSync(path.join(root, "Paccmann Polymer", "original"))).to.equal(false);
      expect(fs.existsSync(path.join(root, "keep-sibling", "original", "file.txt"))).to.equal(true);
      expect(f.writes).to.have.length(2);
    } finally { config.FOLDER = before; fs.rmSync(root, { recursive: true, force: true }); }
  });
});
