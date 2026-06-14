import { basename } from "path";
import { Transform, Readable } from "stream";
import { StringDecoder } from "string_decoder";
import { isBinaryFileSync } from "isbinaryfile";
import { lookup as lookupMime } from "mime-types";

import config from "../config";
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
  private decoder = new StringDecoder("utf8");
  // Trailing decoded text held back between chunks so that terms, URLs, or
  // markdown image patterns straddling a stream chunk boundary still match.
  // Must exceed the longest pattern we replace (terms + URLs + images).
  private pending = "";
  // Raw bytes corresponding to `pending` (plus any partial UTF-8 sequence
  // currently buffered by the decoder). Kept so we can emit the original
  // buffer verbatim when anonymization didn't change anything — that way
  // a binary file misclassified as text, or text with a stray non-UTF-8
  // byte, isn't silently corrupted by a UTF-8 round-trip through the
  // StringDecoder. See discussion in #493.
  private pendingBytes: Buffer = Buffer.alloc(0);
  private static readonly OVERLAP = 4096;

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
  }

  get wasAnonimized() {
    return this.anonimizer.wasAnonymized;
  }

  // Whether the candidate original bytes round-trip to the same byte
  // sequence as `text` re-encoded. Used by the streaming path to confirm
  // it can safely use byte-length slicing.
  private decodeIsLossless(text: string, candidate: Buffer): boolean {
    const reencoded = Buffer.from(text, "utf8");
    return reencoded.length === candidate.length && reencoded.equals(candidate);
  }

  _transform(chunk: Buffer, encoding: string, callback: () => void) {
    if (this.nameVerdict === null) {
      // Name didn't decide. isbinaryfile inspects the first 512 bytes for
      // null bytes and non-printable ratio and returns a decisive boolean.
      this.isText = chunk.length === 0 ? true : !isBinaryFileSync(chunk);
      this.nameVerdict = this.isText;
    }
    if (!this.isText) {
      this.emit("transform", {
        isText: this.isText,
        wasAnonimized: this.wasAnonimized,
        chunk,
      });
      this.push(chunk);
      return callback();
    }

    // StringDecoder buffers trailing partial UTF-8 sequences across chunk
    // boundaries so we never decode half a codepoint into U+FFFD.
    this.pending += this.decoder.write(chunk);
    this.pendingBytes = Buffer.concat([this.pendingBytes, chunk]);

    if (this.pending.length > AnonymizeTransformer.OVERLAP) {
      let split = this.pending.length - AnonymizeTransformer.OVERLAP;
      // Avoid splitting a UTF-16 surrogate pair.
      const code = this.pending.charCodeAt(split);
      if (code >= 0xdc00 && code <= 0xdfff) {
        split -= 1;
      }
      const toProcess = this.pending.slice(0, split);
      this.pending = this.pending.slice(split);

      // Try to keep the original byte slice alongside the decoded text. If
      // the re-encoded text matches those bytes, the decode was lossless and
      // we can safely emit the original buffer when nothing changed —
      // preserving lone CRs, BOMs, etc. If it doesn't match (invalid UTF-8
      // somewhere in the chunk), fall back to encoded output and resync
      // pendingBytes to the canonical re-encoding of what's left.
      const toProcessBytes = Buffer.from(toProcess, "utf8");
      const candidateOriginal = this.pendingBytes.slice(
        0,
        toProcessBytes.length
      );
      const out = this.anonimizer.anonymize(toProcess);
      const lossless = this.decodeIsLossless(toProcess, candidateOriginal);
      let outChunk: Buffer;
      if (out === toProcess && lossless) {
        outChunk = candidateOriginal;
      } else {
        outChunk = Buffer.from(out, "utf8");
      }
      if (lossless) {
        this.pendingBytes = this.pendingBytes.slice(toProcessBytes.length);
      } else {
        this.pendingBytes = Buffer.from(this.pending, "utf8");
      }

      this.emit("transform", {
        isText: this.isText,
        wasAnonimized: this.wasAnonimized,
        chunk: outChunk,
      });
      this.push(outChunk);
    }
    callback();
  }

  _flush(callback: () => void) {
    // Empty file with an unknown extension: no chunk arrived to trigger
    // sniffing. Treat as text — there's nothing to corrupt.
    if (this.nameVerdict === null) {
      this.isText = true;
      this.nameVerdict = true;
    }
    if (this.isText) {
      this.pending += this.decoder.end();
      if (this.pending) {
        const out = this.anonimizer.anonymize(this.pending);
        // At end-of-stream we have every original byte buffered. If nothing
        // changed, emit them verbatim regardless of whether the decode was
        // lossy — preserves invalid-UTF-8 / binary content that happened
        // to be classified as text and didn't match any term.
        const outChunk =
          out === this.pending
            ? this.pendingBytes
            : Buffer.from(out, "utf8");
        this.pending = "";
        this.pendingBytes = Buffer.alloc(0);
        this.emit("transform", {
          isText: this.isText,
          wasAnonimized: this.wasAnonimized,
          chunk: outChunk,
        });
        this.push(outChunk);
      }
    }
    callback();
  }
}

// Markdown image pattern hoisted out of removeImage() so we don't recompile
// it on every chunk of every file streamed through the anonymizer.
const markdownImageRegex =
  /!\[[^\]]*\]\((?<filename>.*?)(?="|\))(?<optionalpart>".*")?\)/g;

interface CompiledTermVariant {
  // Global regex used to replace matches in content (and paths).
  replaceRegex: RegExp;
  // Non-global twin used inside the URL callback to test() without
  // mutating shared lastIndex state.
  testRegex: RegExp;
  mask: string;
}

// Detect the classic exponential-backtracking regex shapes — a quantifier
// applied to a group that itself contains a quantifier or top-level
// alternation, e.g. (a+)+, (a*)*, (a|aa)+. Anonymization terms come from the
// repository owner and are applied as live regexes against file content, so a
// crafted term could otherwise hang the worker (ReDoS, CWE-1333/624). This is
// intentionally conservative: it may over-escape some benign regexes, but it
// never lets a known-catastrophic shape through.
function hasCatastrophicBacktracking(src: string): boolean {
  const quantifiedGroup = /\(([^()]*)\)\s*(?:[*+]|\{\d+(?:,\d*)?\})/g;
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
    for (const variant of termVariants(term)) {
      const bounded = withWordBoundaries(variant.pattern, {
        sniffSource: variant.sniff,
        unicode: variant.unicode,
      });
      const baseFlags = variant.unicode ? "iu" : "i";
      // A user-supplied regex can be valid without `u` but illegal with it
      // (e.g. `[\w-\.]` — a range between class shorthands is rejected only
      // in unicode mode). Skip variants that fail to compile so the other
      // variant still anonymizes.
      try {
        const replaceRegex = new RegExp(bounded, "g" + baseFlags);
        const testRegex = new RegExp(bounded, baseFlags);
        compiled.push({ replaceRegex, testRegex, mask });
      } catch {
        continue;
      }
    }
  }
  return compiled;
}

export class ContentAnonimizer {
  public wasAnonymized = false;
  // Compiled once per instance and reused for every anonymize() call.
  // Streamed files invoke anonymize() many times per file (one per chunk),
  // so caching here avoids rebuilding regexes on every chunk.
  private compiledTerms: CompiledTermVariant[];
  private selfLinkRegexes: RegExp[] | null = null;

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
    this.compiledTerms = compileTerms(opt.terms);
    if (opt.repoName && opt.branchName) {
      const r = opt.repoName;
      const b = opt.branchName;
      this.selfLinkRegexes = [
        new RegExp(`https://raw.githubusercontent.com/${r}/${b}\\b`, "gi"),
        new RegExp(`https://github.com/${r}/blob/${b}\\b`, "gi"),
        new RegExp(`https://github.com/${r}/tree/${b}\\b`, "gi"),
        new RegExp(`https://github.com/${r}`, "gi"),
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
    for (const c of this.compiledTerms) {
      // remove whole url if it contains the term
      content = content.replace(urlRegex, (match) => {
        if (c.testRegex.test(match)) {
          this.wasAnonymized = true;
          return c.mask;
        }
        return match;
      });
      // remove the term in the text
      content = content.replace(c.replaceRegex, () => {
        this.wasAnonymized = true;
        return c.mask;
      });
    }
    return content;
  }

  anonymize(content: string) {
    content = this.removeImage(content);
    content = this.removeLink(content);
    content = this.replaceGitHubSelfLinks(content);
    content = this.replaceTerms(content);
    return content;
  }
}

export function anonymizePath(path: string, terms: string[]) {
  return anonymizePathCompiled(path, compileTerms(terms));
}

// Variant that accepts pre-compiled term regexes — call sites that anonymize
// many paths in a row (tree traversal) should compile once and reuse.
export function anonymizePathCompiled(
  path: string,
  compiled: CompiledTermVariant[]
) {
  for (const c of compiled) {
    path = path.replace(c.replaceRegex, c.mask);
  }
  return path;
}

export { compileTerms };
export type { CompiledTermVariant };
