const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { createTokenCipher } = require("../src/core/credential-crypto");
const { redactSecrets } = require("../src/core/redact-secrets");
const keys = JSON.stringify({ old: Buffer.alloc(32, 1).toString("base64"), next: Buffer.alloc(32, 2).toString("base64") });

describe("credential encryption", () => {
  const cipher = createTokenCipher(keys, "old");
  it("round trips with independent nonces and no plaintext in the envelope", () => {
    const a = cipher.encrypt("secret-token", "owner", "github");
    const b = cipher.encrypt("secret-token", "owner", "github");
    expect(a.nonce).not.to.equal(b.nonce);
    expect(JSON.stringify(a)).not.to.include("secret-token");
    expect(cipher.decrypt(a, "owner", "github")).to.equal("secret-token");
  });
  it("rejects altered envelopes and a different owner/provider", () => {
    const a = cipher.encrypt("secret-token", "owner", "github");
    for (const field of ["nonce", "tag", "ciphertext"]) {
      const bytes = Buffer.from(a[field], "base64"); bytes[0] ^= 1;
      expect(() => cipher.decrypt({ ...a, [field]: bytes.toString("base64") }, "owner", "github")).to.throw("Credential decryption failed");
    }
    for (const patch of [{ version: 2 }, { keyId: "missing" }, { tag: "YQ==" }, { nonce: "!!!!" }]) {
      expect(() => cipher.decrypt({ ...a, ...patch }, "owner", "github")).to.throw();
    }
    expect(() => cipher.decrypt(a, "someone-else", "github")).to.throw();
    expect(() => cipher.decrypt(a, "owner", "other")).to.throw();
    const wrong = createTokenCipher(JSON.stringify({ old: Buffer.alloc(32, 3).toString("base64") }), "old");
    expect(() => wrong.decrypt(a, "owner", "github")).to.throw();
  });
  it("supports key rotation while retaining reads of old credentials", () => {
    const rotated = createTokenCipher(keys, "next");
    expect(rotated.decrypt(cipher.encrypt("secret", "owner", "github"), "owner", "github")).to.equal("secret");
    expect(rotated.encrypt("secret", "owner", "github").keyId).to.equal("next");
  });
  it("refuses missing, malformed, and short keys", () => {
    for (const raw of ["", "null", "[]", "{}", '{"old":"YQ=="}']) {
      expect(() => createTokenCipher(raw, "old")).to.throw();
    }
  });
  it("redacts nested credentials, authorization and tokens in URLs/errors", () => {
    const input = { accessTokens: { github: "plain" }, nested: { authorization: "Bearer plain", encryptedToken: { ciphertext: "abc" } }, message: "failed ghp_abcdef https://example.test/?token=plain" };
    const result = JSON.stringify(redactSecrets(input));
    expect(result).not.to.include("plain");
    expect(result).not.to.include("ghp_abcdef");
    expect(result).not.to.include("abc");
  });
});
