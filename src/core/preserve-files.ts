import { Minimatch } from "minimatch";

/**
 * Glob patterns for files whose content is served without term redaction
 * (#941), e.g. a bibliography where redacted self-citations would reveal the
 * authors. Paths are still anonymized; only file content is left untouched.
 */
export const MAX_PRESERVE_PATTERNS = 200;
export const MAX_PRESERVE_PATTERN_LENGTH = 512;

/** Returns the normalized patterns, or null when the input is invalid. */
export function normalizePreserveFiles(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const patterns: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") return null;
    const pattern = raw.trim();
    if (!pattern) continue;
    if (pattern.length > MAX_PRESERVE_PATTERN_LENGTH) return null;
    // One leading "/" anchors the pattern at the repository root, as in .gitignore.
    const body = pattern.startsWith("/") ? pattern.slice(1) : pattern;
    if (!body || body.includes("\\") ||
      body.split("/").some(segment => segment === ".." || segment === "")) return null;
    if (!patterns.includes(pattern)) patterns.push(pattern);
  }
  return patterns.length > MAX_PRESERVE_PATTERNS ? null : patterns;
}

/**
 * Same rules as .gitignore: a pattern without "/" matches the file name in any
 * folder (`refs.bib`, `*.bib`); a pattern containing "/" matches from the
 * repository root (`paper/refs.bib`, `paper/**`, `/refs.bib`).
 */
export function compilePreserveMatcher(patterns: string[] | undefined): (filePath: string) => boolean {
  const matchers = (patterns || [])
    .filter((pattern): pattern is string => typeof pattern === "string" && pattern.length > 0)
    .map(pattern => {
      const anchored = pattern.startsWith("/");
      const body = anchored ? pattern.slice(1) : pattern;
      return new Minimatch(body, { dot: true, matchBase: !anchored && !body.includes("/") });
    });
  return (filePath: string) => {
    const path = (filePath || "").replace(/^\/+/, "");
    return !!path && matchers.some(matcher => matcher.match(path));
  };
}

export function isPreservedPath(filePath: string | undefined, patterns: string[] | undefined): boolean {
  if (!filePath || !patterns || patterns.length === 0) return false;
  return compilePreserveMatcher(patterns)(filePath);
}
