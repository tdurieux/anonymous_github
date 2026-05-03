import { basename } from "path";
import { Transform, Readable } from "stream";
import { StringDecoder } from "string_decoder";
import { isText } from "istextorbinary";

import config from "../config";
import { termVariants, withWordBoundaries } from "./term-matching";

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

export function isTextFile(filePath: string, content?: Buffer) {
  const filename = basename(filePath);
  const extensions = filename.split(".").reverse();
  const extension = extensions[0].toLowerCase();
  if (config.additionalExtensions.includes(extension)) {
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

    if (this.pending.length > AnonymizeTransformer.OVERLAP) {
      let split = this.pending.length - AnonymizeTransformer.OVERLAP;
      // Avoid splitting a UTF-16 surrogate pair.
      const code = this.pending.charCodeAt(split);
      if (code >= 0xdc00 && code <= 0xdfff) {
        split -= 1;
      }
      const toProcess = this.pending.slice(0, split);
      this.pending = this.pending.slice(split);

      const out = this.anonimizer.anonymize(toProcess);
      const outChunk = Buffer.from(out, "utf8");

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
        this.pending = "";
        const outChunk = Buffer.from(out, "utf8");
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

export class ContentAnonimizer {
  public wasAnonymized = false;

  constructor(
    readonly opt: {
      image?: boolean;
      link?: boolean;
      terms?: string[];
      repoName?: string;
      branchName?: string;
      repoId?: string;
    }
  ) {}

  private removeImage(content: string): string {
    if (this.opt.image !== false) {
      return content;
    }
    // remove image in markdown
    return content.replace(
      /!\[[^\]]*\]\((?<filename>.*?)(?="|\))(?<optionalpart>".*")?\)/g,
      () => {
        this.wasAnonymized = true;
        return config.ANONYMIZATION_MASK;
      }
    );
  }
  private removeLink(content: string): string {
    if (this.opt.link !== false) {
      return content;
    }
    // remove image in markdown
    return content.replace(urlRegex, () => {
      this.wasAnonymized = true;
      return config.ANONYMIZATION_MASK;
    });
  }

  private replaceGitHubSelfLinks(content: string): string {
    if (!this.opt.repoName || !this.opt.branchName) {
      return content;
    }
    const repoName = this.opt.repoName;
    const branchName = this.opt.branchName;

    const replaceCallback = () => {
      this.wasAnonymized = true;
      return `https://${config.APP_HOSTNAME}/r/${this.opt.repoId}`;
    };
    content = content.replace(
      new RegExp(
        `https://raw.githubusercontent.com/${repoName}/${branchName}\\b`,
        "gi"
      ),
      replaceCallback
    );
    content = content.replace(
      new RegExp(`https://github.com/${repoName}/blob/${branchName}\\b`, "gi"),
      replaceCallback
    );
    content = content.replace(
      new RegExp(`https://github.com/${repoName}/tree/${branchName}\\b`, "gi"),
      replaceCallback
    );
    return content.replace(
      new RegExp(`https://github.com/${repoName}`, "gi"),
      replaceCallback
    );
  }

  private replaceTerms(content: string): string {
    const terms = this.opt.terms || [];
    for (let i = 0; i < terms.length; i++) {
      let term = terms[i];
      if (term.trim() == "") {
        continue;
      }
      const mask = config.ANONYMIZATION_MASK + "-" + (i + 1);
      try {
        new RegExp(term, "gi");
      } catch {
        // escape regex characters
        term = term.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&");
      }

      // Try the term verbatim first, then a diacritic-insensitive expansion
      // so "Davo" anonymizes "Davó" (and vice versa). See term-matching.ts.
      for (const variant of termVariants(term)) {
        const bounded = withWordBoundaries(variant.pattern, {
          sniffSource: variant.sniff,
          unicode: variant.unicode,
        });
        const flags = variant.unicode ? "giu" : "gi";
        // remove whole url if it contains the term
        content = content.replace(urlRegex, (match) => {
          if (new RegExp(bounded, flags).test(match)) {
            this.wasAnonymized = true;
            return mask;
          }
          return match;
        });

        // remove the term in the text
        content = content.replace(new RegExp(bounded, flags), () => {
          this.wasAnonymized = true;
          return mask;
        });
      }
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
  for (let i = 0; i < terms.length; i++) {
    let term = terms[i];
    if (term.trim() == "") {
      continue;
    }
    try {
      new RegExp(term, "gi");
    } catch {
      // escape regex characters
      term = term.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&");
    }
    path = path.replace(
      new RegExp(term, "gi"),
      config.ANONYMIZATION_MASK + "-" + (i + 1)
    );
  }
  return path;
}
