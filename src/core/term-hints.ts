import { parseTermSpec } from "./term-matching";

// Symbols that change what a term matches. "." is left out on purpose: it
// matches any character, which can only redact more (hartwell.edu also hides
// hartwell-edu), never less, so warning about every email and domain was
// noise. "-", "," and "#" are literal outside a character class.
const STRUCTURAL = new Set(["*", "+", "?", "(", ")", "[", "]", "{", "}", "|", "^", "$"]);

export interface TermHint {
  /** Zero-based line in the terms text. */
  line: number;
  term: string;
  symbols: string[];
}

/** Terms whose regex symbols probably were meant literally, e.g. "Smith (MIT)" or "C++". */
export function termHints(text: string | undefined): TermHint[] {
  const hints: TermHint[] = [];
  String(text || "").split("\n").forEach((line, index) => {
    const { term } = parseTermSpec(line.trim());
    if (!term) return;
    const symbols: string[] = [];
    for (let i = 0; i < term.length; i++) {
      if (term[i] === "\\") { i++; continue; }
      if (STRUCTURAL.has(term[i]) && !symbols.includes(term[i])) symbols.push(term[i]);
    }
    if (symbols.length) hints.push({ line: index, term, symbols });
  });
  return hints;
}

/** Rewrites one line so its term matches the text as written; keeps any "=>" replacement. */
export function escapeTermLine(text: string, line: number): string {
  const lines = String(text || "").split("\n");
  const raw = lines[line];
  if (raw === undefined) return text;
  const { term } = parseTermSpec(raw.trim());
  if (!term) return text;
  let escaped = "";
  for (let i = 0; i < term.length; i++) {
    if (term[i] === "\\") { escaped += term.slice(i, i + 2); i++; continue; }
    escaped += STRUCTURAL.has(term[i]) || term[i] === "." ? "\\" + term[i] : term[i];
  }
  lines[line] = raw.replace(term, escaped);
  return lines.join("\n");
}
