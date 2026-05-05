import { basename } from "path";
import { Transform, Readable } from "stream";
import { StringDecoder } from "string_decoder";
import { isText } from "istextorbinary";

import config from "../config";
import {
  parseTermSpec,
  termVariants,
  withWordBoundaries,
} from "./term-matching";

const urlRegex =
  /<?\b((https?|ftp|file):\/\/)[-A-Za-z0-9+&@#/%?=~_|!:,.;]+[-A-Za-z0-9+&@#/%=~_|]\b\/?>?/g;

export function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", (err) => reject(err));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

// Common conventional plaintext filenames that have no extension. The
// istextorbinary package returns null (unknown) for these, which our
// `=== true` check then treats as binary — so terms in LICENSE, COPYING,
// etc. silently went through unchanged (#493).
const KNOWN_TEXT_FILENAMES = new Set(
  [
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
  ]
);

export function isTextFile(filePath: string, content?: Buffer) {
  const filename = basename(filePath);
  const extensions = filename.split(".").reverse();
  const extension = extensions[0].toLowerCase();
  if (config.additionalExtensions.includes(extension)) {
    return true;
  }
  if (KNOWN_TEXT_FILENAMES.has(filename.toLowerCase())) {
    return true;
  }
  if (isText(filename)) {
    return true;
  }
  return isText(filename, content);
}

export class AnonymizeTransformer extends Transform {
  public isText: boolean;
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
    // isTextFile may return null for unknown extensions; treat unknown as
    // binary. Sniffing from chunk content is unsafe — split archives,
    // compressed blobs, etc. can have an ASCII-looking first 64 KB and get
    // misclassified as text, which then UTF-8-round-trips and corrupts them.
    this.isText = isTextFile(this.opt.filePath) === true;
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
    try {
      new RegExp(term, "gi");
    } catch {
      term = term.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&");
    }
    for (const variant of termVariants(term)) {
      const bounded = withWordBoundaries(variant.pattern, {
        sniffSource: variant.sniff,
        unicode: variant.unicode,
      });
      const baseFlags = variant.unicode ? "iu" : "i";
      compiled.push({
        replaceRegex: new RegExp(bounded, "g" + baseFlags),
        testRegex: new RegExp(bounded, baseFlags),
        mask,
      });
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
