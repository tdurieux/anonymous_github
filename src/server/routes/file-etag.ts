import { createHash } from "crypto";

// Build an ETag that fingerprints the current upstream content (commit and blob SHA), the file
// path, and the anonymization config the user has saved. Without the config
// part the browser kept serving bytes anonymized under an older term list
// (#439). The path is folded in so two different files inside the same repo
// can never collide.
export function fileETag(
  sourceFingerprint: string | undefined,
  filePath: string,
  options: unknown
): string {
  const h = createHash("sha1");
  h.update(sourceFingerprint || "");
  h.update("|");
  h.update(filePath || "");
  h.update("|");
  h.update(JSON.stringify(options ?? null));
  return `"f-${h.digest("hex")}"`;
}
