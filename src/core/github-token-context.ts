import { createHash } from "crypto";

interface TokenContext { quotaKey: string; renew: (force?: boolean) => Promise<string>; }
const contexts = new Map<string, TokenContext>();
export function registerGitHubToken(token: string, context: TokenContext) {
  if (contexts.size >= 2000 && !contexts.has(token)) contexts.delete(contexts.keys().next().value!);
  contexts.set(token, context);
}
export function githubTokenContext(token: string) { return contexts.get(token); }
export function githubQuotaKey(token: string) {
  return contexts.get(token)?.quotaKey || createHash("sha256").update(token).digest("hex").slice(0, 24);
}
