import { ANONYMIZATION_ERRORS } from "./anonymization-errors";
import { requestReproduction, safeReproductionPath } from "./log-reproduction";
import { safeDiagnosticFields, errorDiagnostics } from "./log-diagnostics";
import { LOG_ROUTES } from "./log-diagnostic-schema";
import { LOG_MODULES, ERROR_CODES, LOG_EVENTS } from "./log-schema";
import { randomUUID } from "crypto";
import { logContext, validTraceId } from "./log-context";

// No arbitrary strings: upstream errors, paths and even innocuous-looking messages
// can contain a private repository name. Add diagnostics here deliberately.
const instance = randomUUID();
const allowed = (values: readonly string[], value: unknown): value is string => typeof value === "string" && values.includes(value);
const events: Record<string, string> = {
  ...LOG_EVENTS, deployment: "deployment",
  request: "request_completed", "slow request": "request_slow", "request interrupted": "request_cancelled",
  "process fatal error": "process_fatal_error", "process started": "process_started",
  "process heartbeat": "process_heartbeat", "job started": "job_started", "job completed": "job_completed",
  "job failed": "job_failed", "job stalled": "job_stalled", "queue heartbeat": "queue_heartbeat",
};
const errorCodes = new Set([
  ...ERROR_CODES, ...ANONYMIZATION_ERRORS, "zip_unsafe_entry_path",
  "repo_renamed", "preparation_interrupted", "commit_not_found", "zip_not_available", "token_refresh_failed", "quota_exceeded", "quota_repository_limit", "quota_storage_limit", "github_rate_limit_exceeded", "github_app_reconnect_required", "github_token_invalid",
  "repository_expired", "repository_not_ready", "repository_not_found", "repository_job_cancelled",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "ABORT_ERR",
  "upstream_error", "upstream_timeout", "invalid_signature", "webhook_processing_failed",
]);
export const LOG_NUMBERS = ["memoryUsedBytes", "memoryFileCacheBytes", "memoryWorkingSetBytes", "memoryWorkingSetRatio", "quotaUsedRepositories", "quotaRepositoryLimit", "quotaUsedBytes", "quotaRequestedBytes", "quotaProjectedBytes", "quotaStorageLimit", "restartMs", "exitCode","droppedLogsInterval","expectedBytes", "measuredMs", "unattributedMs", "overlapMs","status", "httpStatus", "ms", "firstByteMs", "responseMs", "bytes", "bytesPerSecond",
  "attempt", "rss", "memoryLimitBytes", "memoryRatio", "uptime", "activeRequests", "waiting", "active", "delayed", "failed",
  "oldestWaitingMs", "droppedLogs", "loopP95Ms", "upstreamStatus"];
export const LOG_STAGES = ["transfer", "database","repository", "credential_resolution", "upstream", "cache_lookup", "cache_fill", "worker_wait", "anonymize", "streamer_headers"];
export function logRecord(level: string, module: string, args: unknown[]) {
  const context = logContext.getStore() || {};
  const details: Record<string, unknown> = {};
  const keys = [...LOG_NUMBERS, "requestId", "jobId", "hopId", "parentHopId", "deploymentId", "deploymentOperation", "deploymentPhase", "deploymentOutcome", "cancellationOrigin", "cancellationEvidence", "endpointKind", "stageCounts", "stageOpen", "code", "message", "outcome", "method", "route", "queue",
    "errorType", "errorStack", "causeType", "causeStack", "requestPath", "stages", "reason", "phase", "event", "deliveryId", "hostname", "service"];
  // Do not traverse arbitrary objects or invoke error getters while logging.
  for (const arg of args.slice(0, 8)) if (arg && typeof arg === "object") {
    for (const key of keys) {
      try {
        const property = Object.getOwnPropertyDescriptor(arg, key);
        if (property && "value" in property) details[key] = property.value;
      } catch { /* A hostile Proxy must not make logging throw. */ }
    }
  }
  for (const arg of args.slice(0,8)) {
    try { if (arg instanceof Error) Object.assign(details, errorDiagnostics(arg)); } catch { /* hostile Proxy */ }
  }
  const first = typeof args[0] === "string" && args[0].length < 256 ? args[0] : "";
  const event = (Object.hasOwn(events, first) ? events[first] : undefined) || (module.includes("webhook") ? "webhook_log" : "application_log");
  const record: Record<string, unknown> = { timestamp: new Date().toISOString(), severity: level,
    service: context.service || (allowed(["api", "streamer", "worker"], details.service) ? details.service : undefined) || (process.env.SERVICE_NAME?.toLowerCase() === "streamer" ? "streamer" : "api"),
    instance, release: /^[a-f0-9]{7,40}$/.test(process.env.APP_RELEASE || "") ? process.env.APP_RELEASE : "unknown",
    event, message: event, module: LOG_MODULES.includes(module) ? module : "application" };
  for (const key of ["requestId", "jobId", "hopId", "parentHopId", "deploymentId"] as const) {
    const value = details[key] || (key === "deploymentId" ? undefined : context[key]);
    if (validTraceId(value)) record[key] = value;
  }
  if (Number.isSafeInteger(context.attempt)) record.attempt = context.attempt;
  for (const key of LOG_NUMBERS) if (typeof details[key] === "number" && Number.isFinite(details[key])) record[key] = details[key];
  const code = [details.code, details.message].find(value => typeof value === "string" && errorCodes.has(value));
  if (code) record.errorCode = code;
  if (allowed(["protocol", "credentials", "port", "host"], details.reason)) record.reason = details.reason;
  if (allowed(["parse", "find_grant_owners", "reconcile_grant", "persist_installation_block", "reconcile_installation"], details.phase)) record.phase = details.phase;
  if (allowed(["github_app_authorization", "installation", "installation_repositories"], details.event)) record.webhookEvent = details.event;
  if (validTraceId(details.deliveryId)) record.deliveryId = details.deliveryId;
  if (allowed(["github.com", "api.github.com", "codeload.github.com", "raw.githubusercontent.com", "media.githubusercontent.com"], details.hostname)) record.upstreamHost = details.hostname;
  else if (details.hostname) record.upstreamHost = "other";
  for (const [key, values] of Object.entries({ deploymentOperation: ["deploy", "rollback"], deploymentPhase: ["start", "restart", "finish"], deploymentOutcome: ["started", "completed", "failed", "unchanged"], cancellationOrigin: ["unknown", "api", "streamer", "timeout", "upstream"],
    cancellationEvidence: ["response_close", "request_aborted", "upstream_error", "timeout", "local_abort"], endpointKind: ["public", "internal"] })) {
    if (allowed(values, details[key])) record[key] = details[key];
  }
  if (allowed(["completed", "interrupted"], details.outcome)) record.outcome = details.outcome;
  if (allowed(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"], details.method)) record.method = details.method;
  // Only fixed route labels survive; never raw URLs or request parameters.
  const route = context.route || details.route;
  if (typeof route === "string" && LOG_ROUTES.includes(route)) record.route = route.replace(/^\/api\/repo\/:id(?=\/|$)/, "/api/repo/:repoId");
  if (context.method && allowed(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"], context.method)) record.method = context.method;
  Object.assign(record, safeDiagnosticFields(details));
  // Anonymous request paths are diagnostic fields, never metric labels.
  const requestPath = safeReproductionPath(context.requestPath || details.requestPath, record.method);
  if (requestPath) Object.assign(record, requestReproduction(requestPath, record.method));
  if (allowed(["download", "remove", "cache"], details.queue)) record.queue = details.queue;
  if (details.stages && typeof details.stages === "object") for (const key of LOG_STAGES) {
    let value: unknown;
    try { value = Object.getOwnPropertyDescriptor(details.stages, key)?.value; } catch { continue; }
    if (typeof value === "number" && Number.isFinite(value)) record[`stage_${key}_ms`] = value;
  }
  for (const [field, suffix] of [["stageCounts", "count"], ["stageOpen", "open"]]) {
    if (!details[field] || typeof details[field] !== "object") continue;
    for (const stage of LOG_STAGES) {
      let value: unknown;
      try { value = Object.getOwnPropertyDescriptor(details[field], stage)?.value; } catch { continue; }
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) record[`stage_${stage}_${suffix}`] = value;
    }
  }
  return record;
}
