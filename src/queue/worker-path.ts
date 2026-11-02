import { existsSync } from "fs";
import { resolve } from "path";

const PROCESSOR_PATHS = {
  downloadRepository: {
    build: resolve("build/queue/processes/downloadRepository.js"),
    source: resolve("src/queue/processes/downloadRepository.worker.js"),
  },
  removeCache: {
    build: resolve("build/queue/processes/removeCache.js"),
    source: resolve("src/queue/processes/removeCache.worker.js"),
  },
  removeRepository: {
    build: resolve("build/queue/processes/removeRepository.js"),
    source: resolve("src/queue/processes/removeRepository.worker.js"),
  },
} as const;

export type WorkerProcessorName = keyof typeof PROCESSOR_PATHS;

export function resolveWorkerProcessorPath(
  name: WorkerProcessorName,
  fileExists: (path: string) => boolean = existsSync
): string {
  const processor = PROCESSOR_PATHS[name];
  return fileExists(processor.build) ? processor.build : processor.source;
}
