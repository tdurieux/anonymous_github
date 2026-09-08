const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { Types } = require("mongoose");
const config = require("../src/config").default;
const Model = require("../src/core/model/credentials/credentials.model").default;
const UserModel = require("../src/core/model/users/users.model").default;
const { getCredentialToken, setCredential, replaceCredential, credentialCipher } = require("../src/core/credentials");

describe("credential storage boundary", () => {
  const owner = new Types.ObjectId().toString();
  let original, settings, stored;
  beforeEach(() => {
    original = { findOne: Model.findOne, updateOne: Model.updateOne, findById: UserModel.findById };
    settings = [config.CREDENTIAL_KEYS, config.CREDENTIAL_ACTIVE_KEY_ID, config.CREDENTIAL_LEGACY_READS];
    config.CREDENTIAL_KEYS = JSON.stringify({ test: Buffer.alloc(32, 4).toString("base64") });
    config.CREDENTIAL_ACTIVE_KEY_ID = "test";
    config.CREDENTIAL_LEGACY_READS = false;
    stored = null;
    Model.findOne = () => ({ select: () => ({ lean: async () => stored }) });
    Model.updateOne = async (filter, update) => {
      stored = { _id: new Types.ObjectId(), ownerId: owner, provider: "github", ...update.$set };
      return { modifiedCount: 1 };
    };
  });
  afterEach(() => {
    Object.assign(Model, { findOne: original.findOne, updateOne: original.updateOne });
    UserModel.findById = original.findById;
    [config.CREDENTIAL_KEYS, config.CREDENTIAL_ACTIVE_KEY_ID, config.CREDENTIAL_LEGACY_READS] = settings;
  });
  it("writes only ciphertext and resolves the token by owner/provider", async () => {
    await setCredential(owner, "github-secret");
    expect(JSON.stringify(stored)).not.to.include("github-secret");
    expect(await getCredentialToken(owner)).to.equal("github-secret");
  });
  it("refreshes only the credential whose token still matches", async () => {
    await setCredential(owner, "new-login-token");
    expect(await replaceCredential(owner, "stale-token", "refresh-token")).to.equal(false);
    expect(await getCredentialToken(owner)).to.equal("new-login-token");
    expect(await replaceCredential(owner, "new-login-token", "refresh-token")).to.equal(true);
    expect(await getCredentialToken(owner)).to.equal("refresh-token");
  });
  it("fails closed on corrupt ciphertext even with legacy reads enabled", async () => {
    config.CREDENTIAL_LEGACY_READS = true;
    await setCredential(owner, "github-secret");
    stored.encryptedToken.tag = Buffer.alloc(16).toString("base64");
    UserModel.findById = () => { throw new Error("must not fall back"); };
    try { await getCredentialToken(owner); throw new Error("expected failure"); }
    catch (error) { expect(error.message).to.equal("Credential decryption failed"); }
  });
  it("reads legacy users only when explicitly enabled", async () => {
    let reads = 0;
    UserModel.findById = () => ({ select: async () => { reads++; return { accessTokens: { github: "legacy" } }; } });
    expect(await getCredentialToken(owner)).to.equal("");
    expect(reads).to.equal(0);
    config.CREDENTIAL_LEGACY_READS = true;
    expect(await getCredentialToken(owner)).to.equal("legacy");
  });
  it("uses a unique owner/provider index and hides envelopes by default", () => {
    expect(Model.schema.indexes()).to.deep.include([{ ownerId: 1, provider: 1 }, { unique: true, background: true }]);
    expect(Model.schema.path("encryptedToken").options.select).to.equal(false);
    expect(credentialCipher()).to.have.property("encrypt");
  });
});
