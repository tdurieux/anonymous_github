import { CustomError } from "ts-custom-error";
import AnonymizedFile from "./AnonymizedFile";
import Repository from "./Repository";
import GitHubBase from "./source/GitHubBase";
import { GitHubRepository } from "./source/GitHubRepository";
import User from "./User";

/**
 * Custom error message
 */
export default class AnonymousError extends CustomError {
  value?: unknown;
  httpStatus?: number;
  cause?: Error;

  constructor(
    message: string,
    opt?: {
      httpStatus?: number;
      cause?: Error;
      object?: unknown;
    }
  ) {
    super(message);
    this.value = opt?.object;
    this.httpStatus = opt?.httpStatus;
    this.cause = opt?.cause;
  }

  url(): string | undefined {
    if (this.value == null) return undefined;
    try {
      if (this.value instanceof AnonymizedFile) {
        const repoId = this.value.repository?.repoId;
        // anonymizedPath getter can throw if the file isn't initialized;
        // fall back to whatever path is known.
        let p: string | undefined;
        try {
          p = this.value.anonymizedPath;
        } catch {
          p = this.value.filePath;
        }
        return repoId ? `/r/${repoId}/${p ?? ""}` : p;
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  detail(): string | undefined {
    if (this.value == null) return undefined;
    try {
      if (this.value instanceof Repository) return this.value.repoId;
      if (this.value instanceof AnonymizedFile) return undefined;
      if (this.value instanceof GitHubRepository) return this.value.fullName;
      if (this.value instanceof User) return this.value.username;
      if (this.value instanceof GitHubBase) {
        return `GHDownload ${this.value.data.repoId}`;
      }
      if (typeof this.value === "string") return this.value;
      return JSON.stringify(this.value);
    } catch {
      return String(this.value);
    }
  }

  toString(): string {
    let out = this.message;
    const info = this.url() ?? this.detail();
    if (info) {
      out += `: ${info}`;
    }
    if (this.cause) {
      out += `\n\tCause by ${this.cause}\n${this.cause.stack}`;
    }
    return out;
  }
}
