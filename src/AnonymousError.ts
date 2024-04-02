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
  value?: any;
  httpStatus?: number;
  cause?: Error;

  constructor(
    message: string,
    opt?: {
      httpStatus?: number;
      cause?: Error;
      object?: any;
    }
  ) {
    super(message);
    this.value = opt?.object;
    this.httpStatus = opt?.httpStatus;
    this.cause = opt?.cause;
  }

  toString(): string {
    let out = "";
    let detail = this.value ? JSON.stringify(this.value) : null;
    if (this.value instanceof Repository) {
      detail = this.value.repoId;
    } else if (this.value instanceof AnonymizedFile) {
      detail = `/r/${this.value.repository.repoId}/${this.value.anonymizedPath}`;
    } else if (this.value instanceof GitHubRepository) {
      detail = `${this.value.fullName}`;
    } else if (this.value instanceof User) {
      detail = `${this.value.username}`;
    } else if (this.value instanceof GitHubBase) {
      detail = `GHDownload ${this.value.data.repoId}`;
    }
    out += this.message;
    if (detail) {
      out += `: ${detail}`;
    }
    if (this.cause) {
      out += `\n\tCause by ${this.cause}\n${this.cause.stack}`;
    }
    return out;
  }
}
