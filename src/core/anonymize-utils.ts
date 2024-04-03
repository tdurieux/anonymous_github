import { basename } from "path";
import { Transform, Readable } from "stream";
import { isText } from "istextorbinary";
import { trace } from "@opentelemetry/api";

import config from "../config";

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
  public isText: boolean | null = null;
  anonimizer: ContentAnonimizer;

  constructor(
    readonly opt: {
      filePath: string;
    } & ConstructorParameters<typeof ContentAnonimizer>[0]
  ) {
    super();
    this.isText = isTextFile(this.opt.filePath);
    this.anonimizer = new ContentAnonimizer(this.opt);
  }

  get wasAnonimized() {
    return this.anonimizer.wasAnonymized;
  }

  _transform(chunk: Buffer, encoding: string, callback: () => void) {
    trace
      .getTracer("ano-file")
      .startActiveSpan("AnonymizeTransformer.transform", async (span) => {
        span.setAttribute("path", this.opt.filePath);
        if (this.isText === null) {
          this.isText = isTextFile(this.opt.filePath, chunk);
        }
        if (this.isText) {
          const content = this.anonimizer.anonymize(chunk.toString());
          if (this.anonimizer.wasAnonymized) {
            chunk = Buffer.from(content);
          }
        }

        this.emit("transform", {
          isText: this.isText,
          wasAnonimized: this.wasAnonimized,
          chunk,
        });

        this.push(chunk);
        span.end();
        callback();
      });
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
      /!\[[^\]]*\]\((?<filename>.*?)(?=\"|\))(?<optionalpart>\".*\")?\)/g,
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
      // remove whole url if it contains the term
      content = content.replace(urlRegex, (match) => {
        if (new RegExp(`\\b${term}\\b`, "gi").test(match)) {
          this.wasAnonymized = true;
          return mask;
        }
        return match;
      });

      // remove the term in the text
      content = content.replace(new RegExp(`\\b${term}\\b`, "gi"), () => {
        this.wasAnonymized = true;
        return mask;
      });
    }
    return content;
  }

  anonymize(content: string) {
    const span = trace
      .getTracer("ano-file")
      .startSpan("ContentAnonimizer.anonymize");
    try {
      content = this.removeImage(content);
      span.addEvent("removeImage");
      content = this.removeLink(content);
      span.addEvent("removeLink");
      content = this.replaceGitHubSelfLinks(content);
      span.addEvent("replaceGitHubSelfLinks");
      content = this.replaceTerms(content);
      span.addEvent("replaceTerms");
      return content;
    } finally {
      span.end();
    }
  }
}

export function anonymizePath(path: string, terms: string[]) {
  return trace
    .getTracer("ano-file")
    .startActiveSpan("utils.anonymizePath", (span) => {
      span.setAttribute("path", path);
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
      span.setAttribute("return", path);
      span.end();
      return path;
    });
}
