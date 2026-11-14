require("ts-node/register/transpile-only");
const { expect } = require("chai");
const { generateKeyPairSync } = require("crypto");
const fs = require("fs"), os = require("os"), path = require("path");
const { checkGitHubAppKey } = require("../src/scripts/check-github-app-key");

describe("GitHub App replacement key preflight", () => {
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  const config = (extra = {}) => ({ GITHUB_APP_ENABLED: true, GITHUB_APP_PRIVATE_KEY: "", GITHUB_APP_PRIVATE_KEY_FILE: "/missing/key.pem", ...extra });
  it("allows App-disabled deployments without a key", () => {
    expect(() => checkGitHubAppKey(config({ GITHUB_APP_ENABLED: false }))).not.to.throw();
  });
  it("fails a missing mount without disclosing the path", () => {
    let error;
    try { checkGitHubAppKey(config()); } catch (caught) { error = caught; }
    expect(error.message).to.include("signing key is missing").and.not.to.include("/missing/key.pem");
  });
  it("checks mounted key contents and accepts inline key precedence", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-key-check-"));
    const file = path.join(dir, "key.pem");
    try {
      fs.writeFileSync(file, pem, { mode: 0o600 });
      expect(() => checkGitHubAppKey(config({ GITHUB_APP_PRIVATE_KEY_FILE: file }))).not.to.throw();
      fs.writeFileSync(file, "secret-invalid-key");
      let error;
      try { checkGitHubAppKey(config({ GITHUB_APP_PRIVATE_KEY_FILE: file })); } catch (caught) { error = caught; }
      expect(error.message).to.include("invalid").and.not.to.include("secret-invalid-key");
      expect(() => checkGitHubAppKey(config({ GITHUB_APP_PRIVATE_KEY: pem }))).not.to.throw();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("rejects a non-RSA key that cannot produce GitHub RS256 JWTs", () => {
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" });
    expect(() => checkGitHubAppKey(config({ GITHUB_APP_PRIVATE_KEY: key }))).to.throw("invalid");
  });
});
