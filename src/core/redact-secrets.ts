const sensitive = /^(?:authorization|proxy-authorization|cookie|set-cookie|token|access_?tokens?|refresh_?token|encryptedToken|encryptedRefreshToken|private_?key|GITHUB_APP_PRIVATE_KEY|GITHUB_APP_CLIENT_SECRET|GITHUB_APP_WEBHOOK_SECRET|ciphertext|nonce|tag|password|client_?secret|CREDENTIAL_KEYS)$/i;
export function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return value
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[REDACTED]")
    .replace(/((?:access_token|refresh_token|token|code|state)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, "$1 [REDACTED]");
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, seen));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = sensitive.test(key) ? "[REDACTED]" : redactSecrets(item, seen);
  }
  return result;
}
