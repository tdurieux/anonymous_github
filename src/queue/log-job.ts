import { logMemory } from "../core/log-memory";
import { randomUUID } from "crypto";
import { SandboxedJob } from "bullmq";
import { logContext, validTraceId } from "../core/log-context";
import { createLogger, reportOutputDrops } from "../core/logger";
import type { RepoJobData } from "./index";
const logger = createLogger("queue");
export function loggedJob(queue: "download" | "remove" | "cache", work: (job: SandboxedJob<RepoJobData, void>) => Promise<void>) {
  return (job: SandboxedJob<RepoJobData, void>) => logContext.run({
    service: "worker", jobId: validTraceId(job.data.logJobId) ? job.data.logJobId : randomUUID(),
    requestId: validTraceId(job.data.requestId) ? job.data.requestId : undefined,
    attempt: job.attemptsMade + 1,
  }, async () => {
    logger.info("job started", { queue });
    const started = Date.now();
    const heartbeat = setInterval(() => {
      void logMemory().then(memory => reportOutputDrops(drops => logger.info("process heartbeat", { queue, ...memory, uptime: process.uptime(), ...drops })));
    }, 30000); heartbeat.unref();
    try {
      await work(job);
      reportOutputDrops(drops => logger.info("job completed", { queue, ms: Date.now() - started, ...drops }));
    } catch (error) {
      const expected = error instanceof Error && ["DelayedError", "RateLimitDelayError"].includes(error.name);
      reportOutputDrops(drops => logger[expected ? "info" : "error"]("job failed", { queue, ms: Date.now() - started, ...drops }));
      throw error;
    } finally { clearInterval(heartbeat); }
  });
}
