const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { createOwnerCredentialRecovery } = require("../src/core/recover-owner-credential");
const { migrateCredentials } = require("../src/core/migrate-credentials");
const { createTokenCipher } = require("../src/core/credential-crypto");

describe("owner credential recovery", function () {
  this.timeout(5000);
  it("rejects a shared admin token and deduplicates the owner's token", async () => {
    const calls = [];
    const recover = createOwnerCredentialRecovery(async token => {
      calls.push(token);
      return { githubId: token === "admin" ? "9" : "42" };
    });
    expect(await recover(42, ["admin", "owner", "owner"])).to.deep.equal({ token: "owner" });
    expect(await recover("9", ["admin", "owner"])).to.deep.equal({ token: "admin" });
    expect(calls).to.deep.equal(["admin", "owner"]);
  });
  it("does not choose between distinct valid owner tokens", async () => {
    const recover = createOwnerCredentialRecovery(async () => ({ githubId: "42" }));
    expect(await recover("42", ["old", "new"])).to.deep.equal({ issue: "multiple_valid_owner_tokens" });
  });
  it("ignores revoked tokens but does not recover a mismatched identity", async () => {
    const recover = createOwnerCredentialRecovery(async token => token === "revoked"
      ? { issue: "invalid_or_revoked_token" } : { githubId: "9" });
    expect(await recover("42", ["revoked", "admin"])).to.deep.equal({ issue: "no_valid_owner_token" });
  });
  it("does not call GitHub without a usable recorded ID", async () => {
    const recover = createOwnerCredentialRecovery(async () => { throw new Error("must not call"); });
    for (const id of [undefined, null, "", "login", 0, -1]) {
      expect(await recover(id, ["token"])).to.deep.equal({ issue: "missing_or_invalid_owner_github_id" });
    }
  });
  it("halts on a failed request even after a matching token", async () => {
    const recover = createOwnerCredentialRecovery(async token => token === "owner"
      ? { githubId: "42" } : { issue: "github_http_403", halt: true });
    expect(await recover("42", ["owner", "unknown"])).to.deep.equal({ issue: "github_http_403", halt: true });
  });
  it("redacts thrown request errors", async () => {
    const recover = createOwnerCredentialRecovery(async () => { throw new Error("secret"); });
    expect(await recover("42", ["secret"])).to.deep.equal({ issue: "github_request_failed", halt: true });
  });
});

// Exercise the migration's write/cleanup decisions independently of a Mongo server.
function fixture() {
  const user = { _id: "owner", status: "active", externalIDs: { github: "42" } };
  const rows = [{ _id: "repo", owner: "owner", source: { accessToken: "owner-token" }, accessToken: "admin-token" }];
  const writes = [];
  let credential;
  const cursor = values => ({ batchSize() { return this; }, async *[Symbol.asyncIterator]() { yield* values; } });
  const db = { collection(name) {
    return {
      find: () => cursor(name === "users" ? [user] : name === "anonymizedrepositories" ? rows : []),
      findOne: async () => name === "users" ? user : credential,
      createIndex: async () => {},
      updateOne: async (filter, update) => {
        writes.push({ name, update });
        if (name === "credentials") credential = update.$setOnInsert;
        return { modifiedCount: 1 };
      },
      updateMany: async (filter, update) => { writes.push({ name, update }); return { modifiedCount: 1 }; },
    };
  } };
  return { db, user, rows, writes, credential: () => credential };
}

describe("migration owner recovery decisions", function () {
  const cipher = createTokenCipher(JSON.stringify({ test: Buffer.alloc(32, 7).toString("base64") }), "test");
  const identify = async token => ({ githubId: token === "owner-token" ? "42" : "9" });
  it("previews without writes, then encrypts the matching token without changing ownership", async () => {
    const f = fixture();
    const options = { recoverOwnerTokens: true, preferOwnerToken: true, identify };
    expect((await migrateCredentials(f.db, cipher, options)).created).to.equal(1);
    expect(f.writes).to.deep.equal([]);
    const result = await migrateCredentials(f.db, cipher, { ...options, apply: true, removeLegacy: true });
    expect(result.issues).to.equal(0);
    expect(cipher.decrypt(f.credential().encryptedToken, "owner", "github")).to.equal("owner-token");
    expect(f.writes.filter(w => w.name !== "credentials").every(w => !!w.update.$unset)).to.equal(true);
    expect(f.rows[0].owner).to.equal("owner");
  });
  it("leaves all tokens untouched on ambiguity", async () => {
    const f = fixture();
    const events = [];
    const result = await migrateCredentials(f.db, cipher, {
      recoverOwnerTokens: true, apply: true, removeLegacy: true,
      identify: async () => ({ githubId: "42" }), report: e => events.push(e),
    });
    expect(result.issues).to.equal(1);
    expect(events[0].issue).to.equal("multiple_valid_owner_tokens");
    expect(f.writes).to.deep.equal([]);
    expect(JSON.stringify(events)).not.to.include("owner-token");
  });
  it("halts without cleaning the current owner on transient failures", async () => {
    const f = fixture();
    const result = await migrateCredentials(f.db, cipher, {
      recoverOwnerTokens: true, apply: true, removeLegacy: true,
      identify: async () => ({ issue: "github_http_429", halt: true }),
    });
    expect(result.halted).to.equal(true);
    expect(f.writes).to.deep.equal([]);
  });
  it("preserves the authoritative user token without making GitHub requests", async () => {
    const f = fixture();
    f.user.accessTokens = { github: "authoritative" };
    await migrateCredentials(f.db, cipher, {
      recoverOwnerTokens: true, preferOwnerToken: true, apply: true,
      identify: async () => { throw new Error("must not call"); },
    });
    expect(cipher.decrypt(f.credential().encryptedToken, "owner", "github")).to.equal("authoritative");
  });
});
