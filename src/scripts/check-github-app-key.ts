import { createPrivateKey, createSign } from "crypto";
import { readFileSync } from "fs";

type AppKeyConfig = {
  GITHUB_APP_ENABLED: boolean;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_PRIVATE_KEY_FILE: string;
};

// Run in each replacement service, with its actual user, environment and mounts.
// Never include the key, its path, or crypto error details in deployment output.
export function checkGitHubAppKey(config: AppKeyConfig): void {
  if (!config.GITHUB_APP_ENABLED) return;
  try {
    const key = createPrivateKey(config.GITHUB_APP_PRIVATE_KEY || readFileSync(config.GITHUB_APP_PRIVATE_KEY_FILE, "utf8"));
    if (key.asymmetricKeyType !== "rsa") throw new Error("Not an RSA key");
    createSign("RSA-SHA256").update("anonymous-github-deployment-preflight").sign(key);
  } catch {
    throw new Error("GitHub App signing key is missing, unreadable or invalid. Preserve the GitHub App Compose override and verify the replacement service's key configuration.");
  }
}

if (require.main === module) {
  try {
    checkGitHubAppKey(require("../config").default);
  } catch {
    // Configuration validation can also fail. Do not echo environment values.
    process.stderr.write("GitHub App preflight failed. Check required configuration and the read-only signing-key mount before deploying.\n");
    process.exitCode = 1;
  }
}
