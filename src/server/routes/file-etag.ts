import { createHash } from "crypto";

// Build an ETag that fingerprints both the upstream content (?v=<sha>) and
// the anonymization config the user has saved. Without the config part, the
// browser kept serving content anonymized under an older term list — see
// #439 (anonymization "doesn't work" in regular tabs but works in incognito).
export function fileETag(
  versionParam: string | undefined,
  options: unknown
): string {
  const h = createHash("sha1");
  h.update(versionParam || "");
  h.update("|");
  h.update(JSON.stringify(options ?? null));
  return `"f-${h.digest("hex")}"`;
}
