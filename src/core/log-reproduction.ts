// Explicit admin diagnostics: public anonymous repository ID and request pathname only.
// Never collect upstream owner/repository URLs, headers, query strings or bodies.
// Listing folders use query parameters; a wildcard here would capture upstream
// /:owner/files/{readme,branches,tree,file} source lookups.
const anonymousRequest = /^\/api\/repo\/([A-Za-z0-9_-]{3,200})(?:\/(file\/[A-Za-z0-9._~!$&'()+,;=@%/-]+|files(?:\/(?:counts|search))?\/?|(?:zip|options|refresh|coauthors|extend)\/?))?\/?$/;
export function safeReproductionPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  const match = anonymousRequest.exec(value);
  if (!match || /%(?![a-fA-F0-9]{2})/.test(value)) return undefined;
  try {
    const path = decodeURIComponent(match[2] || "");
    // Reject controls, traversal, URL syntax, encoded delimiters and double encoding.
    // eslint-disable-next-line no-control-regex -- reject control characters from stored paths
    if (/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069\ufffd\\:?#%]/.test(path) || path.includes("//") || path.split("/").some(part => part === "." || part === "..")) return undefined;
  } catch { return undefined; }
  return value;
}
export function requestReproduction(url: string) {
  const requestPath = safeReproductionPath(url.split("?", 1)[0]);
  return requestPath ? { requestPath, repoId: anonymousRequest.exec(requestPath)![1] } : {};
}
