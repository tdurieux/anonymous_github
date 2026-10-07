import { RE2JS } from "re2js";
import { Script } from "vm";
import { basename } from "path";
import { Transform, Readable } from "stream";
import { isBinaryFileSync } from "isbinaryfile";
import { lookup as lookupMime } from "mime-types";

import config from "../config";
import { TermPresenceIndex } from "./term-presence";
import {
  parseTermSpec,
  termVariants,
  withWordBoundaries,
} from "./term-matching";

const urlRegex =
  /<?\b((https?|ftp|file):\/\/)[-A-Za-z0-9+&@#/%?=~_|!:,.;]+[-A-Za-z0-9+&@#/%=~_|]\b\/?>?/g;

export function streamToString(
  stream: Readable,
  maxBytes = 2 * 1024 * 1024
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => {
      const buf = Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        stream.destroy();
        reject(
          new Error(
            `Stream exceeded ${maxBytes} bytes, refusing to buffer into memory`
          )
        );
        return;
      }
      chunks.push(buf);
    });
    stream.on("error", (err) => reject(err));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

// Common conventional plaintext filenames that have no extension and no MIME
// match. Without this whitelist a bare LICENSE / COPYING / etc. would fall
// through to content sniffing, which is fine for non-empty files but breaks
// on zero-byte ones — so we short-circuit them here (#493).
const KNOWN_TEXT_FILENAMES = new Set([
  "license",
  "licence",
  "copying",
  "copyright",
  "authors",
  "contributors",
  "readme",
  "changelog",
  "changes",
  "notice",
  "install",
  "todo",
  "version",
  "manifest",
]);

// Application/* MIME types that carry text payloads. text/* is always text,
// application/* needs an allowlist (most are binary: zip, pdf, octet-stream).
const TEXTUAL_APPLICATION_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/javascript",
  "application/ecmascript",
  "application/typescript",
  "application/toml",
  "application/sql",
  "application/x-sql",
  "application/x-sh",
  "application/x-csh",
  "application/x-yaml",
  "application/yaml",
  "application/x-httpd-php",
  "application/graphql",
  "application/x-tex",
  "application/x-latex",
  "application/x-perl",
  "application/x-ruby",
  "application/x-python",
]);

function isTextualMime(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (TEXTUAL_APPLICATION_MIMES.has(mime)) return true;
  // application/*+json, application/*+xml, application/*+yaml
  return /\+(json|xml|yaml)$/.test(mime);
}

// Name-only classification: returns true (known text), false (known binary),
// or null when the name alone is inconclusive. The streaming transformer
// resolves null by sniffing the first chunk with isbinaryfile.
function classifyByName(filePath: string): boolean | null {
  const name = basename(filePath);
  const extension = name.split(".").reverse()[0].toLowerCase();
  if (config.additionalExtensions.includes(extension)) return true;
  if (KNOWN_TEXT_FILENAMES.has(name.toLowerCase())) return true;
  // mime-types maps `.bat` to application/x-msdownload, the same MIME as
  // .exe/.dll, so the MIME allowlist can't distinguish them. Batch scripts
  // are text and must be anonymized (#735).
  if (extension === "bat" || extension === "cmd") return true;
  const mime = lookupMime(name);
  if (mime === false) return null;
  // mime-types treats `.ts` as video/mp2t; route.ts already special-cases it.
  // Prefer text for the ambiguous extension since it matches our typical use.
  if (extension === "ts") return true;
  return isTextualMime(mime);
}

export function isTextFile(filePath: string, content?: Buffer): boolean {
  const byName = classifyByName(filePath);
  if (byName === true) return true;
  if (byName === false) return false;
  // Name was inconclusive — sniff the buffer if we have one. isbinaryfile
  // checks for null bytes / non-printable ratio in the first 512 bytes
  // and returns a decisive boolean.
  if (content && content.length > 0) return !isBinaryFileSync(content);
  return false;
}

export class AnonymizeTransformer extends Transform {
  // Set in the constructor for known extensions; left null until the first
  // chunk arrives for unknown extensions, where it's resolved by sniffing.
  // Consumers of the "transform" event always see a resolved boolean — we
  // sniff before emitting.
  public isText!: boolean;
  private nameVerdict: boolean | null;
  anonimizer: ContentAnonimizer;
  private wholeChunks: Buffer[] = [];
  private wholeBytes = 0;
  private readonly bufferWholeStream: boolean;

  constructor(
    readonly opt: {
      filePath: string;
    } & ConstructorParameters<typeof ContentAnonimizer>[0]
  ) {
    super();
    // Tri-state: name-based check returns true (known text), false (known
    // binary), or null (name inconclusive). For null we defer to a content
    // sniff on the first chunk in _transform — known binary extensions
    // (archives, compressed blobs, images) are resolved here and never
    // reach the sniff path (#493).
    this.nameVerdict = classifyByName(this.opt.filePath);
    if (this.nameVerdict !== null) this.isText = this.nameVerdict;
    this.anonimizer = new ContentAnonimizer(this.opt);

    // Matching a prefix in isolation can split even a fixed-length name or
    // turn the split into a false word boundary. Preserve the complete text
    // whenever a rewrite is enabled, with MAX_FILE_SIZE as a hard limit.
    this.bufferWholeStream =
      opt.link === false || opt.image === false ||
      (opt.terms || []).length > 0 || !!(opt.repoName && opt.branchName);
  }

  get wasAnonimized() {
    return this.anonimizer.wasAnonymized;
  }

  _transform(chunk: Buffer, encoding: string, callback: (error?: Error) => void) {
    if (this.nameVerdict === null) {
      this.isText = chunk.length === 0 ? true : !isBinaryFileSync(chunk);
      this.nameVerdict = this.isText;
    }
    if (this.isText && this.bufferWholeStream) {
      this.wholeBytes += chunk.length;
      if (this.wholeBytes > config.MAX_FILE_SIZE) {
        this.wholeChunks = [];
        return callback(new Error(`Text file exceeded ${config.MAX_FILE_SIZE} bytes`));
      }
      this.wholeChunks.push(chunk);
    } else {
      this.emit("transform", { isText: this.isText, wasAnonimized: false, chunk });
      this.push(chunk);
    }
    callback();
  }

  _flush(callback: (error?: Error) => void) {
    try {
      if (this.nameVerdict === null) this.isText = true;
      if (this.wholeBytes) {
        const original = Buffer.concat(this.wholeChunks, this.wholeBytes);
        this.wholeChunks = [];
        const text = original.toString("utf8");
        const out = this.anonimizer.anonymize(text);
        // Preserve the original encoding when no replacement was needed.
        const chunk = out === text ? original : Buffer.from(out, "utf8");
        this.emit("transform", { isText: true, wasAnonimized: this.wasAnonimized, chunk });
        this.push(chunk);
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

// Markdown image pattern hoisted out of removeImage() so we don't recompile
// it on every chunk of every file streamed through the anonymizer.
const markdownImageRegex =
  /!\[[^\]]*\]\((?<filename>.*?)(?="|\))(?<optionalpart>".*")?\)/g;

interface CompiledTermVariant {
  // RE2 for regular patterns; time-limited native fallback for JS extensions.
  pattern: RE2JS | RegExp;
  // A boundary-free native search for fixed-width patterns can rule out
  // absent terms. Candidate replacement retains RE2's boundary semantics.
  literalPrefilter?: RegExp;
  asciiPattern?: RegExp;
  asciiReplacement?: string;
  asciiBefore?: boolean;
  asciiAfter?: boolean;
  before: boolean;
  after: boolean;
  mask: string;
}

// Detect exponential-backtracking regex shapes — a quantifier applied to a
// group that itself contains a quantifier or top-level alternation, e.g.
// (a+)+, (a*)*, (a|aa)+, and the nested form ((a+))+. Anonymization terms come
// from the repository owner and are applied as live regexes against file
// content, so a crafted term could otherwise hang the worker (ReDoS,
// CWE-1333/624). This is a heuristic, not a proof: the lazy [\s\S]*? body
// matches across nested parentheses so nested quantified groups are caught,
// and it errs toward over-escaping benign regexes rather than letting a
// dangerous one through. It is not exhaustive — exotic backtracking shapes may
// still slip past — so it backstops, rather than replaces, any execution-time
// bound on the regex.
function hasCatastrophicBacktracking(src: string): boolean {
  const quantifiedGroup = /\(([\s\S]*?)\)\s*(?:[*+]|\{\d+(?:,\d*)?\})/g;
  let match: RegExpExecArray | null;
  while ((match = quantifiedGroup.exec(src)) !== null) {
    const inner = match[1];
    if (/[*+]|\{\d+(?:,\d*)?\}/.test(inner) || inner.includes("|")) {
      return true;
    }
  }
  return false;
}


function compileTerms(terms: string[] | undefined): CompiledTermVariant[] {
  if (!terms || terms.length === 0) return [];
  const compiled: CompiledTermVariant[] = [];
  for (let i = 0; i < terms.length; i++) {
    const spec = terms[i];
    if (spec.trim() === "") continue;
    // #285 — entries of the form "term=>replacement" override the default
    // XXXX-N mask so users can scrub with their preferred token.
    const parsed = parseTermSpec(spec);
    let term = parsed.term;
    const mask =
      parsed.replacement !== null
        ? parsed.replacement
        : config.ANONYMIZATION_MASK + "-" + (i + 1);
    // Use the term as a regex only when it both compiles AND is free of
    // catastrophic-backtracking shapes; otherwise escape it to a literal so a
    // malicious term cannot trigger ReDoS during anonymization.
    let useAsRegex = true;
    try {
      new RegExp(term, "gi");
    } catch {
      useAsRegex = false;
    }
    if (!useAsRegex || hasCatastrophicBacktracking(term)) {
      term = term.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&");
    }
    // Plain text and unquantified dots have fixed width in code points.
    // Exclude all other regex syntax so the native search cannot backtrack
    // exponentially. This includes dotted names, emails and domains.
    const isFixedWidth = !/[\\^$*+?()[\]{}|]/.test(term);
    for (const variant of termVariants(term)) {
      // Stripping a combining-mark-only term can produce an empty variant.
      // Keep zero-width matches on RE2's progress-aware iterator.
      const fixedWidth = isFixedWidth && variant.pattern.length > 0;
      const bounded = withWordBoundaries(variant.pattern, {
        sniffSource: variant.sniff,
        unicode: variant.unicode,
      });
      const before = variant.unicode && bounded.startsWith("(?<![\\p{L}\\p{N}_])");
      const after = variant.unicode && bounded.endsWith("(?![\\p{L}\\p{N}_])");
      try {
        const pattern = RE2JS.compile(
          variant.unicode ? variant.pattern : bounded,
          RE2JS.CASE_INSENSITIVE
        );
        compiled.push({ pattern, before, after, mask,
          asciiPattern: fixedWidth ? new RegExp(bounded.replace(/\./g, "[^\\n]"), "giu") : undefined,
          asciiReplacement: fixedWidth ? mask.replace(/\$/g, () => "$$") : undefined,
          asciiBefore: !variant.unicode && bounded.startsWith("\\b"),
          asciiAfter: !variant.unicode && bounded.endsWith("\\b"),
          // RE2 uses Unicode case folding even for the non-diacritic pass.
          // Omit boundaries so this search can only rule out absent terms.
          literalPrefilter: fixedWidth
            // RE2's dot excludes only LF; JS dot also excludes CR and U+2028/9.
            ? new RegExp(variant.pattern.replace(/\./g, "[^\\n]"), "iu") : undefined });
      } catch {
        // Retain JavaScript-only syntax and large repetition counts under
        // the execution deadline; RE2 handles the common case without backtracking.
        try {
          compiled.push({ pattern: new RegExp(bounded, variant.unicode ? "giu" : "gi"),
            before: false, after: false, mask });
        } catch { /* The other variant may still compile. */ }
      }

    }
  }
  return compiled;
}

interface CompiledTermPlan {
  terms: CompiledTermVariant[];
  presence: TermPresenceIndex | null;
}

// Every file in a ZIP uses the same rules. Reuse immutable compiled patterns
// across transformers, with bounded retention for unrelated repositories.
const termPlans = new Map<string, CompiledTermPlan>();
function compiledTermPlan(terms: string[] | undefined): CompiledTermPlan {
  const key = JSON.stringify([config.ANONYMIZATION_MASK, terms || []]);
  const cached = termPlans.get(key);
  if (cached) return cached;
  const compiled = compileTerms(terms);
  const plan = {
    terms: compiled,
    presence: compiled.length && compiled.length <= 256 && compiled.every(term => term.literalPrefilter)
      ? new TermPresenceIndex(compiled.map(term => term.literalPrefilter!)) : null,
  };
  if (key.length <= 8192 && compiled.length <= 256) {
    if (termPlans.size >= 64) termPlans.delete(termPlans.keys().next().value!);
    termPlans.set(key, plan);
  }
  return plan;
}

export class ContentAnonimizer {
  public wasAnonymized = false;
  // Per-instance metadata references the bounded cache of compiled rules.
  private compiledTerms: CompiledTermVariant[];
  private selfLinkRegexes: RegExp[] | null = null;
  private termPresence: TermPresenceIndex | null = null;

  constructor(
    readonly opt: {
      image?: boolean;
      link?: boolean;
      terms?: string[];
      repoName?: string;
      branchName?: string;
      repoId?: string;
    }
  ) {
    const plan = compiledTermPlan(opt.terms);
    // Keep per-instance metadata independent. Regex matching is synchronous;
    // native replacement resets lastIndex and RE2 creates a fresh matcher.
    this.compiledTerms = plan.terms.map(term => ({ ...term }));
    this.termPresence = plan.presence;
    if (opt.repoName && opt.branchName) {
      const r = escapeRegex(opt.repoName);
      const b = escapeRegex(opt.branchName);
      this.selfLinkRegexes = [
        new RegExp(
          `https://raw\\.githubusercontent\\.com/${r}/${b}(?=$|[/?#])`,
          "gi"
        ),
        new RegExp(`https://github\\.com/${r}/blob/${b}(?=$|[/?#])`, "gi"),
        new RegExp(`https://github\\.com/${r}/tree/${b}(?=$|[/?#])`, "gi"),
        new RegExp(`https://github\\.com/${r}(?=$|[/?#])`, "gi"),
      ];
    }
  }

  private removeImage(content: string): string {
    if (this.opt.image !== false) {
      return content;
    }
    return content.replace(markdownImageRegex, () => {
      this.wasAnonymized = true;
      return config.ANONYMIZATION_MASK;
    });
  }
  private removeLink(content: string): string {
    if (this.opt.link !== false) {
      return content;
    }
    return content.replace(urlRegex, () => {
      this.wasAnonymized = true;
      return config.ANONYMIZATION_MASK;
    });
  }

  private replaceGitHubSelfLinks(content: string): string {
    if (!this.selfLinkRegexes) return content;
    const replacement = `https://${config.APP_HOSTNAME}/r/${this.opt.repoId}`;
    const cb = () => {
      this.wasAnonymized = true;
      return replacement;
    };
    for (const re of this.selfLinkRegexes) {
      content = content.replace(re, cb);
    }
    return content;
  }

  private replaceTerms(content: string): string {
    if (!this.compiledTerms.length) return content;
    let candidates = this.termPresence?.candidates(content);
    // On ASCII input both engines have identical fixed-width matching and
    // word boundaries. Native replacement avoids allocating one JS match
    // object per CSV value. Non-ASCII input keeps RE2 validation below.
    let asciiContent = (!candidates || candidates.size > 0) && /^\p{ASCII}*$/u.test(content);
    for (let index = 0; index < this.compiledTerms.length; index++) {
      if (candidates && !candidates.has(index)) continue;
      const c = this.compiledTerms[index];
      // An absent term cannot occur inside a URL either.
      if (c.literalPrefilter && !c.literalPrefilter.test(content)) continue;
      const previous = content;
      content = content.replace(urlRegex, (match) => {
        if (replaceTerm(match, c, true) !== match) {
          this.wasAnonymized = true;
          return c.mask;
        }
        return match;
      });
      // URL replacement may already have inserted a non-ASCII custom mask.
      if (content !== previous) asciiContent = asciiContent && /^\p{ASCII}*$/u.test(c.mask);
      const replaced = replaceTerm(content, c, asciiContent);
      if (replaced !== content) this.wasAnonymized = true;
      content = replaced;
      // Masks and changed boundaries can introduce later matches. Re-index
      // only after a real change, never once per absent term.
      if (content !== previous) {
        asciiContent = asciiContent && /^\p{ASCII}*$/u.test(c.mask);
        candidates = this.termPresence?.candidates(content, index);
      }
    }
    return content;
  }

  anonymize(content: string): string {
    return runWithAnonymizationDeadline(() => {
      content = this.removeImage(content);
      content = this.removeLink(content);
      content = this.replaceGitHubSelfLinks(content);
      content = this.replaceTerms(content);
      return content;
    });
  }
}

export function anonymizePath(path: string, terms: string[]) {
  return anonymizePathCompiled(path, compileTerms(terms));
}

export function hasCustomTermReplacement(terms: string[] | undefined): boolean {
  return (terms || []).some(
    (term) => parseTermSpec(term).replacement !== null
  );
}

// Variant that accepts pre-compiled term regexes — call sites that anonymize
// many paths in a row (tree traversal) should compile once and reuse.
export function anonymizePathCompiled(
  path: string,
  compiled: CompiledTermVariant[]
) {
  const replace = () => {
    for (const c of compiled) path = replaceTerm(path, c);
    return path;
  };
  return compiled.some((term) => term.pattern instanceof RegExp)
    ? runWithAnonymizationDeadline(replace)
    : replace();
}

export { compileTerms };
export type { CompiledTermVariant };

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// V8 interrupts even a native RegExp that never returns to JavaScript. A
// timeout aborts the operation instead of returning partially anonymized text.
const anonymizationScript = new Script("run()");
function runWithAnonymizationDeadline(run: () => string): string {
  return anonymizationScript.runInNewContext({ run }, { timeout: 1000 });
}

function replaceTerm(content: string, term: CompiledTermVariant, asciiContent = false): string {
  if (term.pattern instanceof RegExp) {
    return content.replace(term.pattern, () => term.mask);
  }
  if (term.literalPrefilter && asciiContent && term.asciiPattern) {
    return content.replace(term.asciiPattern, term.asciiReplacement!);
  }
  if (term.literalPrefilter) {
    const validated = new Map<string, boolean>();
    const candidates = new RegExp(term.literalPrefilter.source, "giu");
    const pieces: string[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = candidates.exec(content))) {
      const candidate = match[0], start = match.index, end = start + candidate.length;
      let valid = true;
      if (term.before && /[\p{L}\p{N}_]$/u.test(content.slice(Math.max(0, start - 2), start))) valid = false;
      if (term.after && /^[\p{L}\p{N}_]/u.test(content.slice(end, end + 2))) valid = false;
      // On ASCII candidates the fixed-width native and RE2 searches agree.
      // Check RE2's ASCII word boundaries explicitly: JS /iu\b/ also treats
      // Kelvin sign and long s as word characters, while RE2 does not.
      if (valid && /^\p{ASCII}*$/u.test(candidate)) {
        if (term.asciiBefore && asciiWordAt(content, start - 1) === asciiWordAt(content, start)) valid = false;
        if (term.asciiAfter && asciiWordAt(content, end - 1) === asciiWordAt(content, end)) valid = false;
      } else if (valid) {
        // Keep RE2 authoritative for Unicode case folding. Repeated values in
        // datasets share small contexts; cap this cache independently of size.
        const offset = Math.max(0, start - 2);
        const window = content.slice(offset, end + 2);
        const key = `${start - offset}:${window}`;
        const cached = validated.get(key);
        if (cached === undefined) {
          const check = (term.pattern as RE2JS).matcher(window);
          valid = check.find(start - offset) && check.start() === start - offset && check.end() === end - offset;
          if (validated.size < 256) validated.set(key, valid);
        } else valid = cached;
      }
      if (!valid) {
        // A boundary-rejected candidate must not hide an overlapping match,
        // e.g. the second a-a in "xa-a-a". Advance by one Unicode code point.
        candidates.lastIndex = start + (content.codePointAt(start)! > 0xffff ? 2 : 1);
        continue;
      }
      pieces.push(content.slice(cursor, start), term.mask);
      cursor = end;
    }
    if (!pieces.length) return content;
    pieces.push(content.slice(cursor));
    return pieces.join("");
  }

  const matcher = term.pattern.matcher(content);
  const pieces: string[] = [];
  let cursor = 0;
  while (matcher.find()) {
    const start = matcher.start(), end = matcher.end();
    if (term.before && /[\p{L}\p{N}_]$/u.test(content.slice(Math.max(0, start - 2), start))) continue;
    if (term.after && /^[\p{L}\p{N}_]/u.test(content.slice(end, end + 2))) continue;
    pieces.push(content.slice(cursor, start), term.mask);
    cursor = end;
  }
  if (!pieces.length) return content;
  pieces.push(content.slice(cursor));
  return pieces.join("");
}

function asciiWordAt(content: string, index: number): boolean {
  const code = content.charCodeAt(index);
  return code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 95;
}
