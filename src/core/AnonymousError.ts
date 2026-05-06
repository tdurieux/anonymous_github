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
  private explicitUrl?: string;

  constructor(
    message: string,
    opt?: {
      httpStatus?: number;
      cause?: Error;
      object?: unknown;
      url?: string;
    }
  ) {
    super(message);
    this.value = opt?.object;
    this.httpStatus = opt?.httpStatus;
    this.cause = opt?.cause;
    this.explicitUrl = opt?.url;
  }

  url(): string | undefined {
    if (this.explicitUrl) return this.explicitUrl;
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
      // For plain objects (typically request bodies passed in by route
      // handlers), pull out the diagnostic fingerprint instead of dumping
      // the entire body. Routes throw with `object: req.body`, which used
      // to bloat the log with the full JSON of options/source/etc — none
      // of which helps an operator triage the failure.
      if (typeof this.value === "object") {
        const v = this.value as Record<string, unknown>;
        const fingerprint: string[] = [];
        if (typeof v.repoId === "string") fingerprint.push(`repoId=${v.repoId}`);
        if (typeof v.fullName === "string") fingerprint.push(`fullName=${v.fullName}`);
        if (typeof v.repositoryFullName === "string")
          fingerprint.push(`pr=${v.repositoryFullName}`);
        if (typeof v.pullRequestId === "string" || typeof v.pullRequestId === "number")
          fingerprint.push(`prId=${v.pullRequestId}`);
        if (typeof v.gistId === "string") fingerprint.push(`gistId=${v.gistId}`);
        if (typeof v.username === "string") fingerprint.push(`user=${v.username}`);
        if (typeof v.conferenceID === "string")
          fingerprint.push(`conference=${v.conferenceID}`);
        if (fingerprint.length) return fingerprint.join(" ");
        // Fall back to a bounded, readable preview rather than a giant
        // escaped JSON blob. Keep it small so the rendered card stays tidy.
        const json = JSON.stringify(this.value);
        return json.length > 120 ? json.slice(0, 117) + "…" : json;
      }
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
