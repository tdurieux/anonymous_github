import config from "../config";
import GitHubBase from "./source/GitHubBase";
import { isText } from "istextorbinary";
import { basename } from "path";
import { Transform } from "stream";
import { Readable } from "stream";
import AnonymizedFile from "./AnonymizedFile";

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
  public isText = false;

  constructor(private readonly file: AnonymizedFile) {
    super();
  }

  _transform(chunk: Buffer, encoding: string, callback: () => void) {
    const isText = isTextFile(this.file.anonymizedPath, chunk);

    if (isText) {
      this.isText = true;
      const anonimizer = new ContentAnonimizer(chunk.toString(), {
        repoId: this.file.repository.repoId,
        image: this.file.repository.options.image,
        link: this.file.repository.options.link,
        terms: this.file.repository.options.terms,
        repoName: (this.file.repository.source as GitHubBase).githubRepository
          ?.fullName,
        branchName:
          (this.file.repository.source as GitHubBase).branch?.name || "main",
      });
      anonimizer.anonymize();
      if (anonimizer.wasAnonymized) {
        this.wasAnonimized = true;
        chunk = Buffer.from(anonimizer.content);
      }
    }

    this.emit("transform", {
      isText,
      wasAnonimized: this.wasAnonimized,
      chunk,
    });

    this.push(chunk);
    callback();
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
    this.removeImage();
    this.removeLink();
    this.replaceGitHubSelfLinks();
    this.replaceTerms();
    return this.content;
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
