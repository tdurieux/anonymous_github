// Only fixed codes cross the worker boundary; source text and OS paths never do.
export const ANONYMIZATION_ERRORS = [
  "anonymized_output_too_large", "anonymization_memory_budget_exceeded",
  "anonymization_queue_full", "anonymization_queue_timeout", "anonymization_cancelled",
  "anonymization_worker_exited", "anonymization_deadline_exceeded",
  "anonymization_spool_budget_exceeded", "anonymization_worker_failed",
  "anonymization_storage_full", "anonymization_io_failed",
] as const;
export function anonymizationErrorCode(error: unknown): string {
  const data = (key: string) => {
    try { const p = Object.getOwnPropertyDescriptor(error, key); return p && "value" in p ? p.value : undefined; }
    catch { return undefined; }
  };
  const message = data("message"), code = data("code");
  if (typeof message === "string" && (ANONYMIZATION_ERRORS as readonly string[]).includes(message)) return message;
  if (code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || code === "ERR_WORKER_OUT_OF_MEMORY") {
    return code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ? "anonymization_deadline_exceeded" : "anonymization_memory_budget_exceeded";
  }
  if (code === "ENOSPC") return "anonymization_storage_full";
  if (["EIO", "ENOENT", "EACCES", "EMFILE", "ENFILE"].includes(code)) return "anonymization_io_failed";
  return "anonymization_worker_failed";
}
