import config from "../config";
import GitHubBase from "./source/GitHubBase";
import { isText } from "istextorbinary";
import { basename } from "path";
import { Transform } from "stream";
import { Readable } from "stream";
import AnonymizedFile from "./AnonymizedFile";
import { trace } from "@opentelemetry/api";

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
  public wasAnonimized = false;
  public isText: boolean | null = null;

  constructor(
    private readonly opt: {
      filePath: string;
    } & ConstructorParameters<typeof ContentAnonimizer>[1]
  ) {
    super();
    this.isText = isTextFile(this.opt.filePath);
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
          const anonimizer = new ContentAnonimizer(chunk.toString(), this.opt);
          anonimizer.anonymize();
          if (anonimizer.wasAnonymized) {
            this.wasAnonimized = true;
            chunk = Buffer.from(anonimizer.content);
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

interface Anonymizationptions {
  repoId?: string;
  source?: {};
  options: {
    terms: string[];
    image: boolean;
    link: boolean;
    pageSource?: {
      branch: string;
      path: string;
    };
  };
}

export class ContentAnonimizer {
  public wasAnonymized = false;

  constructor(
    public content: string,
    readonly opt: {
      image?: boolean;
      link?: boolean;
      terms?: string[];
      repoName?: string;
      branchName?: string;
      repoId?: string;
    }
  ) {}

  private removeImage() {
    if (this.opt.image !== false) {
      return;
    }
    // remove image in markdown
    this.content = this.content.replace(
      /!\[[^\]]*\]\((?<filename>.*?)(?=\"|\))(?<optionalpart>\".*\")?\)/g,
      () => {
        this.wasAnonymized = true;
        return config.ANONYMIZATION_MASK;
      }
    );
  }
  private removeLink() {
    if (this.opt.link !== false) {
      return;
    }
    // remove image in markdown
    this.content = this.content.replace(urlRegex, () => {
      this.wasAnonymized = true;
      return config.ANONYMIZATION_MASK;
    });
  }

  private replaceGitHubSelfLinks() {
    if (!this.opt.repoName || !this.opt.branchName) {
      return;
    }
    const repoName = this.opt.repoName;
    const branchName = this.opt.branchName;

    const replaceCallback = () => {
      this.wasAnonymized = true;
      return `https://${config.APP_HOSTNAME}/r/${this.opt.repoId}`;
    };
    this.content = this.content.replace(
      new RegExp(
        `https://raw.githubusercontent.com/${repoName}/${branchName}\\b`,
        "gi"
      ),
      replaceCallback
    );
    this.content = this.content.replace(
      new RegExp(`https://github.com/${repoName}/blob/${branchName}\\b`, "gi"),
      replaceCallback
    );
    this.content = this.content.replace(
      new RegExp(`https://github.com/${repoName}/tree/${branchName}\\b`, "gi"),
      replaceCallback
    );
    this.content = this.content.replace(
      new RegExp(`https://github.com/${repoName}`, "gi"),
      replaceCallback
    );
  }

  private replaceTerms() {
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
      this.content = this.content.replace(urlRegex, (match) => {
        if (new RegExp(`\\b${term}\\b`, "gi").test(match)) {
          this.wasAnonymized = true;
          return mask;
        }
        return match;
      });

      // remove the term in the text
      this.content = this.content.replace(
        new RegExp(`\\b${term}\\b`, "gi"),
        () => {
          this.wasAnonymized = true;
          return mask;
        }
      );
    }
  }

  anonymize() {
    const span = trace
      .getTracer("ano-file")
      .startSpan("ContentAnonimizer.anonymize");
    try {
      this.removeImage();
      span.addEvent("removeImage");
      this.removeLink();
      span.addEvent("removeLink");
      this.replaceGitHubSelfLinks();
      span.addEvent("replaceGitHubSelfLinks");
      this.replaceTerms();
      span.addEvent("replaceTerms");
      return this.content;
    } finally {
      span.end();
    }
  }
}

export function anonymizeContent(
  content: string,
  repository: Anonymizationptions
) {
  let repoName: string | undefined;
  let branchName: string | undefined;
  if (repository.source instanceof GitHubBase) {
    repoName = repository.source.githubRepository.fullName;
    branchName = repository.source.branch.name;
  }
  return new ContentAnonimizer(content, {
    repoId: repository.repoId,
    image: repository.options.image,
    link: repository.options.link,
    terms: repository.options.terms,
    repoName,
    branchName,
  }).anonymize();
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
