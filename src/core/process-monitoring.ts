import { createLogger, serializeError } from "./logger";

/** Observe fatal errors without overriding Node's default exit behavior. */
export function installFatalErrorLogging(service: "api" | "streamer") {
  const logger = createLogger("process");
  const report = (error: Error, origin: string) => logger.error("process fatal error", {
    ...serializeError(error), code: "process_fatal_error", service, origin,
  });
  process.on("uncaughtExceptionMonitor", report);
  return () => process.removeListener("uncaughtExceptionMonitor", report);
}
