import { createHash } from "crypto";
import { logRecord, LOG_NUMBERS, LOG_STAGES } from "../core/log-record";
import { logContext, validTraceId } from "../core/log-context";
import { LOG_EVENTS } from "../core/log-schema";

const services = ["api", "streamer", "worker", "nginx", "mongodb", "redis", "backup"];
const events = new Set([...Object.values(LOG_EVENTS), "deployment", "application_log", "webhook_log", "request_completed", "request_slow", "request_cancelled", "process_fatal_error", "process_started", "process_heartbeat", "job_started", "job_completed", "job_failed", "job_stalled", "queue_heartbeat", "edge_request", "infrastructure_log"]);
const windows: Record<string, number> = { "15m": 15, "1h": 60, "6h": 360, "24h": 1440 };
let active = 0;
export class InvalidLogQuery extends Error {}
export function logOptions(query: Record<string, unknown>, correlation = false) {
  const permitted = correlation ? ["window", "kind", "id"] : ["window", "service", "release"];
  if (Object.keys(query).some(key => !permitted.includes(key)) || Object.values(query).some(value => typeof value !== "string")) throw new InvalidLogQuery();
  const window = (query.window as string) || "1h";
  if (!Object.hasOwn(windows, window)) throw new InvalidLogQuery();
  const service = (query.service as string) || "";
  const release = (query.release as string) || "";
  if (service && !services.includes(service)) throw new InvalidLogQuery();
  if (release && !/^(?:[a-f0-9]{7,40}|unknown)$/.test(release)) throw new InvalidLogQuery();
  if (correlation && (!validTraceId(query.id) || !["requestId", "jobId"].includes(String(query.kind)))) throw new InvalidLogQuery();
  const end = new Date().toISOString();
  const start = new Date(Date.now() - windows[window] * 60000).toISOString();
  return { window, start, end, service, release, id: query.id as string, kind: query.kind as "requestId" | "jobId" };
}
type Options = ReturnType<typeof logOptions>;
type Row = Record<string, string | number>;
function endpoint(value: string | undefined) {
  if (!value) return null;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("invalid_operator_endpoint");
  return url.origin;
}
// A total response byte cap applies even if Content-Length is absent or dishonest.
async function read(url: string, signal: AbortSignal, body?: URLSearchParams) {
  const response = await fetch(url, { method: body ? "POST" : "GET", body, signal, redirect: "error", headers: body ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined });
  if (!response.ok || !response.body) throw new Error("logging_unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error("logging_response_limit");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => undefined); }
}
function safeRow(input: Record<string, unknown>): Row | null {
  const time = typeof input._time === "string" ? input._time : input.timestamp;
  if (typeof time !== "string" || !Number.isFinite(Date.parse(time))) return null;
  // Reuse the application's reviewed projection. Never return raw backend data.
  const numeric = [...LOG_NUMBERS, ...LOG_STAGES.flatMap(stage => [`stage_${stage}_ms`, `stage_${stage}_count`, `stage_${stage}_open`])];
  const data: Record<string, unknown> = { ...input, code: input.errorCode };
  for (const key of numeric) if (typeof input[key] === "string" && /^-?\d+(?:\.\d+)?$/.test(input[key] as string)) data[key] = Number(input[key]);
  for (const [field, suffix] of [["stages", "ms"], ["stageCounts", "count"], ["stageOpen", "open"]]) {
    data[field] = Object.fromEntries(LOG_STAGES.map(stage => [stage, data[`stage_${stage}_${suffix}`]]));
  }
  // Revalidate finite route and diagnostic allowlists; never pass raw strings.
  const projected = logContext.run({}, () => logRecord(["error", "warn", "info", "debug"].includes(String(input.severity)) ? String(input.severity) : "info", String(input.module || "application"), ["", data]));
  const result: Row = { timestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(time) ? time : new Date(time).toISOString(), severity: String(projected.severity), service: services.includes(String(input.service)) ? String(input.service) : "unknown", event: events.has(String(input.event)) ? String(input.event) : "application_log", module: String(projected.module), release: /^(?:[a-f0-9]{7,40}|unknown)$/.test(String(input.release)) ? String(input.release) : "unknown" };
  for (const key of [...numeric, "deploymentId", "deploymentOperation", "deploymentPhase", "deploymentOutcome", "outcome", "endpointKind", "cancellationOrigin", "cancellationEvidence", "hopId", "parentHopId", "errorCode", "requestId", "jobId", "queue", "route", "method", "errorType", "errorStack", "causeType", "causeStack", "repoId", "requestPath"]) if (typeof projected[key] === "string" || typeof projected[key] === "number") result[key] = projected[key] as string | number;
  if (validTraceId(input.instance)) result.instance = input.instance;
  return result;
}
export function safeRedisLog(entry: Record<string, unknown>) {
  const detail = Array.isArray(entry.raw) ? entry.raw.find(value => value && typeof value === "object" && !Array.isArray(value)) || {} : {};
  const row = safeRow({ ...detail, _time: entry.ts, severity: entry.level, module: entry.module,
    errorCode: detail.errorCode || detail.code || detail.message, event: detail.event || entry.message });
  return row ? { ts: row.timestamp, level: row.severity, module: row.module, message: row.errorCode || row.errorType || row.event, raw: [row] } : null;
}
async function rows(base: string, query: string, limit: number, signal: AbortSignal) {
  const text = await read(base + "/select/logsql/query", signal, new URLSearchParams({ query, limit: String(limit) }));
  const lines = text.split("\n").filter(Boolean);
  let rejected = 0;
  const records = lines.slice(0, limit).flatMap(line => {
    try { const row = safeRow(JSON.parse(line)); if (row) return [row]; } catch { /* Malformed records are not raw UI diagnostics. */ }
    rejected++; return [];
  });
  return { records, partial: lines.length >= limit || rejected > 0 };
}
const range = (o: Options) => `_time:[${o.start}, ${o.end}]`;
function grafana(o: Options) {
  try {
    const value = process.env.ADMIN_LOG_GRAFANA_URL;
    if (!value) return null;
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.search = ""; url.hash = "";
    url.searchParams.set("from", String(Date.parse(o.start))); url.searchParams.set("to", String(Date.parse(o.end)));
    if (o.service) url.searchParams.set("var-service", `^${o.service}$`);
    if (o.release) url.searchParams.set("var-release", `^${o.release}$`);
    if (o.id) url.searchParams.set(o.kind === "jobId" ? "var-job_id" : "var-request_id", o.id);
    return url.toString();
  } catch { return null; }
}
// ISO Z timestamps may mix seconds, milliseconds and nanoseconds. Pad only the
// comparison key; keep original precision in the displayed event.
function timestampKey(value: string | number) {
  return String(value).replace(/(?:\.(\d+))?Z$/, (_match, fraction = "") => `.${fraction.padEnd(9, "0")}Z`);
}
export function incidentGroups(records: Row[], baseline?: { records: Row[]; partial: boolean }) {
  const signature = (row: Row) => JSON.stringify([row.service, row.module, row.event, row.errorCode || "", row.severity,
    row.status || row.httpStatus || "", row.errorType || "", String(row.errorStack || "").split("\n")[0].replace(/:\d+:\d+\)$/, ")")]);
  const known = new Set((baseline?.records || []).map(signature));
  const groups = new Map<string, { fingerprint: string; count: number; first: string; last: string; sample: Row;
    requests: Set<string>; uncorrelatedRecords: number; releases: Set<string>; regression: string }>();
  for (const row of records) {
    const key = signature(row);
    const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 24);
    let existing = groups.get(fingerprint);
    if (existing) { existing.count++; existing.first = timestampKey(existing.first) < timestampKey(row.timestamp) ? existing.first : String(row.timestamp); existing.last = timestampKey(existing.last) > timestampKey(row.timestamp) ? existing.last : String(row.timestamp); }
    else {
      existing = { fingerprint, count: 1, first: String(row.timestamp), last: String(row.timestamp), sample: row,
        requests: new Set(), releases: new Set(), uncorrelatedRecords: 0,
        regression: known.has(key) ? "known" : baseline && !baseline.partial && baseline.records.length ? "not_seen_in_baseline" : "unknown" };
      groups.set(fingerprint, existing);
    }
    if (validTraceId(row.requestId)) existing.requests.add(row.requestId); else existing.uncorrelatedRecords++;
    if (typeof row.release === "string") existing.releases.add(row.release);
  }
  return [...groups.values()].map(({ requests, releases, ...value }) => ({ ...value, affectedRequests: requests.size, releases: [...releases] }))
    .sort((a, b) => timestampKey(b.last).localeCompare(timestampKey(a.last)));
}
async function collector(signal: AbortSignal) {
  try {
    const base = endpoint(process.env.ADMIN_LOG_VECTOR_URL);
    if (!base) return { state: "disabled", dropped: null };
    const metrics = await read(base + "/metrics", signal);
    let dropped = 0; let observed = false;
    for (const line of metrics.split("\n")) {
      if (/^vector_buffer_max_size_/.test(line)) observed = true;
      if (/^vector_buffer_discarded_events_total[ {]/.test(line) || (/^vector_component_discarded_events_total[ {]/.test(line) && !line.includes('intentional="true"'))) {
        const value = Number(line.split(/\s+/)[1]); if (Number.isFinite(value)) dropped += value;
      }
    }
    return { state: observed ? "reachable" : "unknown", dropped: observed ? dropped : null };
  } catch { return { state: "unreachable", dropped: null }; }
}
export async function investigateLogs(options: Options, correlation = false) {
  const common = { source: "victorialogs", window: options.window, start: options.start, end: options.end, redisCollecting: process.env.LOG_REDIS_MIRROR !== "off", grafanaUrl: grafana(options) };
  let base: string | null;
  try { base = endpoint(process.env.ADMIN_LOG_URL); } catch { return { ...common, state: "misconfigured", groups: [], events: [] }; }
  if (!base) return { ...common, state: "disabled", groups: [], events: [] };
  if (active >= 2) return { ...common, state: "busy", groups: [], events: [] };
  active++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000); timer.unref();
  try {
    if (correlation) {
      const first = await rows(base, `${range(options)} ${options.kind}:"${options.id}" | sort by (_time)`, 201, controller.signal);
      let records = first.records; let partial = first.partial;
      if (options.kind === "jobId") {
        const allIds = [...new Set(records.map(row => row.requestId).filter(validTraceId))];
        const ids = allIds.slice(0, 4);
        partial ||= allIds.length > 4;
        if (ids.length) {
          const linked = await rows(base, `${range(options)} (${ids.map(id => `requestId:"${id}"`).join(" OR ")}) NOT jobId:"${options.id}" | sort by (_time)`, 201, controller.signal);
          records = [...records, ...linked.records]; partial ||= linked.partial;
        }
      }
      // Queries are disjoint by jobId; preserve legitimate identical events.
      const unique = records.sort((a, b) => timestampKey(a.timestamp).localeCompare(timestampKey(b.timestamp)));
      return { ...common, state: partial || unique.length > 200 ? "partial" : unique.length ? "ready" : "empty", events: unique.slice(0, 200), limit: 200 };
    }
    // Historical collector output omits unknown releases and keeps edge 5xx at info.
    const release = options.release === "unknown" ? ' (release:unknown OR release:"")' : options.release ? ` release:${options.release}` : "";
    const filter = `${range(options)} (severity:error OR severity:warn OR (service:nginx event:edge_request status:>=500 status:<600))${options.service ? ` service:${options.service}` : ""}${release}`;
    const baselineStart = new Date(Date.parse(options.start) - 24 * 60 * 60 * 1000).toISOString();
    const compareRelease = options.release && options.release !== "unknown";
    const [errors, heartbeat, drops, baseline] = await Promise.all([
      rows(base, `${filter} | sort by (_time) desc`, 1001, controller.signal),
      rows(base, '_time:5m (event:process_heartbeat OR event:queue_heartbeat OR event:job_completed OR event:job_failed) | sort by (_time) desc', 501, controller.signal),
      collector(controller.signal),
      compareRelease ? rows(base, `_time:[${baselineStart}, ${options.start}) (severity:error OR severity:warn OR (service:nginx event:edge_request status:>=500 status:<600))${options.service ? ` service:${options.service}` : ""} NOT release:${options.release} NOT release:unknown NOT release:"" | sort by (_time) desc`, 1001, controller.signal) : Promise.resolve(undefined),
    ]);
    const latest = new Map<string, Row>();
    for (const row of heartbeat.records) {
      const key = `${row.service}:${row.instance || ""}:${row.queue || ""}`;
      if (!latest.has(key)) latest.set(key, row);
    }
    const recent = heartbeat.records.filter(row => Date.parse(String(row.timestamp)) > Date.now() - 90000);
    const streamers = new Set(recent.filter(row => row.service === "streamer" && row.event === "process_heartbeat").map(row => row.instance).filter(Boolean)).size;
    const queues = new Set(recent.filter(row => row.event === "queue_heartbeat").map(row => row.queue).filter(Boolean)).size;
    const missing = [...(!recent.some(row => row.service === "api" && row.event === "process_heartbeat") ? ["API"] : []), ...(streamers < 4 ? ["streamers"] : []), ...(queues < 3 ? ["queues"] : [])];
    const records = errors.records.slice(0, 1000);
    return { ...common, state: errors.partial || heartbeat.partial ? "partial" : missing.length ? "stale" : records.length ? "ready" : "empty", groups: incidentGroups(records, baseline), baseline: baseline ? { start: baselineStart, end: options.start, captured: baseline.records.length,
      partial: baseline.partial, comparison: "other_releases_previous_24h" } : null, captured: records.length, limit: 1000, telemetry: { missing, streamers, queues, partial: heartbeat.partial, instances: [...latest.values()].map(row => ({ service: row.service, instance: row.instance, last: row.timestamp, dropped: row.droppedLogs ?? null })), collector: drops } };
  } catch { return { ...common, state: "unreachable", groups: [], events: [] }; }
  finally { controller.abort(); clearTimeout(timer); active--; }
}
