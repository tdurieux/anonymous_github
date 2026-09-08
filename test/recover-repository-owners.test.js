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
