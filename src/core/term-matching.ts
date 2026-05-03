// Pure helpers for term-based anonymization. Extracted from anonymize-utils
// so unit tests can import them without pulling in the config module (which
// reads process.env at load time).

// JS regex \b only fires at a word/non-word transition, where word chars are
// [A-Za-z0-9_]. So `\bterm\b` silently fails to match when the term begins or
// ends with a non-word char (e.g. "@tdurieux", "Davó", "@author .*"). Only
// emit a boundary on sides where the term has a word-char edge; otherwise the
// boundary would never match.
//
// `sniffSource` lets callers decide boundaries from a different string than
// the actual pattern — needed when the pattern is an expanded character class
// (ends in "]") but the matched text is still a letter.
//
// `unicode: true` emits lookaround boundaries that treat any Unicode letter
// as a word char, so a trailing boundary still fires next to "ó" etc. The
// regex consuming the result must be created with the `u` flag.
export function withWordBoundaries(
  termPattern: string,
  opt: { sniffSource?: string; unicode?: boolean } = {}
): string {
  // Strip a leading group like (?:...) or (...) when sniffing the first/last
  // significant char so users wrapping their regex in a group still get
  // boundaries applied. Best-effort — not a full parser.
  const sniff = (opt.sniffSource ?? termPattern).replace(
    /^\(\?[:=!]?|^\(|\)$/g,
    ""
  );
  const first = sniff.charAt(0);
  const last = sniff.charAt(sniff.length - 1);
  const isWord = (c: string) => /[A-Za-z0-9_]/.test(c);
  const before = opt.unicode ? "(?<![\\p{L}\\p{N}_])" : "\\b";
  const after = opt.unicode ? "(?![\\p{L}\\p{N}_])" : "\\b";
  const lead = first && isWord(first) ? before : "";
  const trail = last && isWord(last) ? after : "";
  return `${lead}${termPattern}${trail}`;
}

export function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

// Map of base Latin letter -> regex character class covering common accented
// variants. Used to make term matching diacritic-insensitive in both
// directions: typing "Davo" matches "Davó" in the text, and typing "Davó"
// (after stripping diacritics) does the same. Coverage focuses on Latin
// letters that show up in real names — extend as needed.
export const DIACRITIC_CLASSES: Record<string, string> = {
  a: "[aàáâãäåāăąǎ]",
  c: "[cçćĉċč]",
  d: "[dďđ]",
  e: "[eèéêëēĕėęěȩ]",
  g: "[gĝğġģǧ]",
  h: "[hĥħȟ]",
  i: "[iìíîïĩīĭįıǐ]",
  j: "[jĵǰ]",
  k: "[kķǩ]",
  l: "[lĺļľŀł]",
  n: "[nñńņňŉŋ]",
  o: "[oòóôõöōŏőøǒ]",
  r: "[rŕŗř]",
  s: "[sśŝşšș]",
  t: "[tţťŧț]",
  u: "[uùúûüũūŭůűųǔ]",
  w: "[wŵẁẃẅ]",
  y: "[yýÿŷỳ]",
  z: "[zźżž]",
};

// Build a regex source that matches the given (already-escaped) term in a
// diacritic-insensitive way. ASCII letters are replaced with a character
// class that includes their accented siblings; other chars are left alone so
// regex metacharacters and escape sequences keep working.
export function diacriticInsensitive(escapedTerm: string): string {
  let out = "";
  let i = 0;
  while (i < escapedTerm.length) {
    const c = escapedTerm[i];
    // Pass through backslash escapes verbatim (e.g. "\." or "\d").
    if (c === "\\" && i + 1 < escapedTerm.length) {
      out += c + escapedTerm[i + 1];
      i += 2;
      continue;
    }
    const lower = c.toLowerCase();
    out += DIACRITIC_CLASSES[lower] || c;
    i += 1;
  }
  return out;
}

// Build the term variants to try for one user-provided term. Each variant
// produces a separate replacement pass.
export function termVariants(escapedTerm: string): {
  pattern: string;
  sniff: string;
  unicode: boolean;
}[] {
  const stripped = stripDiacritics(escapedTerm);
  return [
    { pattern: escapedTerm, sniff: escapedTerm, unicode: false },
    { pattern: diacriticInsensitive(stripped), sniff: stripped, unicode: true },
  ];
}
