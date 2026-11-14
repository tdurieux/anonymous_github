import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";

export interface LogContext { requestId?: string; jobId?: string; attempt?: number; service?: string }
export const logContext = new AsyncLocalStorage<LogContext>();
export const validTraceId = (value: unknown): value is string => typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function jobTrace() {
  const requestId = logContext.getStore()?.requestId;
  return { logJobId: randomUUID(), ...(requestId ? { requestId } : {}) };
}
