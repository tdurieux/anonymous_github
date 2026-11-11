import { Minimatch } from "minimatch";

/**
 * Patterns for files whose content is served without term redaction (#941),
 * e.g. a bibliography where redacted self-citations would reveal the authors.
 * Paths are still anonymized; only file content is left untouched.
 *
 * Same rules as .gitignore: a pattern without "/" matches the file name in any
 * folder (`*.bib`); a pattern containing "/" matches from the repository root
 * (`paper/refs.bib`, `/refs.bib`, `paper/**`); `!pattern` excludes again, and
 * the last matching pattern wins. Picked files are stored as root-anchored
 * paths with glob characters escaped by a backslash (`/paper/\{a,b\}.bib`).
 */
export const MAX_PRESERVE_PATTERNS = 200;
export const MAX_PRESERVE_PATTERN_LENGTH = 512;

function parsePattern(pattern: string) {
  const negated = pattern.startsWith("!");
  const rest = negated ? pattern.slice(1) : pattern;
  const anchored = rest.startsWith("/");
  const body = anchored ? rest.slice(1) : rest;
  return { negated, anchored, body };
}

/**
 * Drops repeated patterns but keeps the last copy: rules apply in order and
 * the last match wins, so an earlier copy can never decide the result.
 */
export function dedupePreservePatterns(patterns: string[]): string[] {
  return patterns.filter((pattern, index) => patterns.lastIndexOf(pattern) === index);
}

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
    const { body } = parsePattern(pattern);
    if (!body || body.split("/").some(segment => segment === ".." || segment === "")) return null;
    patterns.push(pattern);
  }
  const unique = dedupePreservePatterns(patterns);
  return unique.length > MAX_PRESERVE_PATTERNS ? null : unique;
}

/**
 * Compiles the patterns once. The returned function applies them in order to
 * `initial` (whether the file is already preserved), so a later `!pattern`
 * can exclude what an earlier pattern included.
 */
export function compilePreserveMatcher(patterns: string[] | undefined): (filePath: string, initial?: boolean) => boolean {
  const rules = (patterns || [])
    .filter((pattern): pattern is string => typeof pattern === "string" && pattern.length > 0)
    .map(pattern => {
      const { negated, anchored, body } = parsePattern(pattern);
      return {
        negated,
        matcher: new Minimatch(body, { dot: true, nonegate: true, nocomment: true, matchBase: !anchored && !body.includes("/") }),
      };
    });
  return (filePath: string, initial = false) => {
    const path = (filePath || "").replace(/^\/+/, "");
    if (!path) return false;
    let preserved = initial;
    for (const rule of rules) {
      if (rule.negated ? preserved : !preserved) {
        if (rule.matcher.match(path)) preserved = !rule.negated;
      }
    }
    return preserved;
  };
}

export function isPreservedPath(filePath: string | undefined, patterns: string[] | undefined): boolean {
  if (!filePath || !patterns || patterns.length === 0) return false;
  return compilePreserveMatcher(patterns)(filePath);
}
