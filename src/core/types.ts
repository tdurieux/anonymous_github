export interface Branch {
  name: string;
  commit: string;
  readme?: string;
}

export enum RepositoryStatus {
  QUEUE = "queue",
  PREPARING = "preparing",
  DOWNLOAD = "download",
  READY = "ready",
  EXPIRED = "expired",
  EXPIRING = "expiring",
  REMOVED = "removed",
  REMOVING = "removing",
  ERROR = "error",
}

export type ConferenceStatus = "ready" | "expired" | "removed";

export type SourceStatus = "available" | "unavailable";

export type TreeElement = Tree | TreeFile;

export interface Tree {
  [key: string]: TreeElement;
}

export interface TreeFile {
  sha: string;
  size: number;
}
