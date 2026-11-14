import { logMemory } from "./log-memory";
import { createLogger, serializeError, getDroppedOutput } from "./logger";

/** Observe fatal errors without overriding Node's default exit behavior. */
export function installFatalErrorLogging(service: "api" | "streamer") {
  const logger = createLogger("process");
  const report = (error: Error, origin: string) => logger.error("process fatal error", {
    ...serializeError(error), code: "process_fatal_error", service, origin,
  });
  logger.info("process started", { service });
  const heartbeat = setInterval(() => {
    void logMemory().then(memory => logger.info("process heartbeat", {
      service, uptime: process.uptime(), ...memory, droppedLogs: getDroppedOutput() }));
  }, 30000);
  heartbeat.unref();
  process.on("uncaughtExceptionMonitor", report);
  return () => { clearInterval(heartbeat); process.removeListener("uncaughtExceptionMonitor", report); };
}
