import { createHash } from "crypto";

interface TokenContext { quotaKey: string; renew: (force?: boolean) => Promise<string>; publicRepository?: string; }
const contexts = new Map<string, TokenContext>();
export function registerGitHubToken(token: string, context: TokenContext) {
  if (contexts.size >= 2000 && !contexts.has(token)) contexts.delete(contexts.keys().next().value!);
  contexts.set(token, context);
}
export function githubTokenContext(token: string) {
  const context = contexts.get(token);
  if (!context && token.startsWith("public-read:")) throw new Error("Public repository access context expired");
  return context;
}
// Public handles belong to this process. Revalidate here, then let the
// streamer fetch public bytes anonymously without forwarding the owner's token.
export async function githubTokenForStreamer(token: string, repository: string | undefined): Promise<string> {
  const context = githubTokenContext(token);
  if (!context?.publicRepository) return token;
  if (!repository || context.publicRepository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error("Public repository access context mismatch");
  }
  await context.renew();
  return "";
}
export function githubQuotaKey(token: string) {
  return contexts.get(token)?.quotaKey || createHash("sha256").update(token).digest("hex").slice(0, 24);
}
