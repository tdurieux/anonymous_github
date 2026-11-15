export type FailureOrigin = "unknown" | "api" | "streamer" | "timeout" | "upstream";
export type FailureEvidence = "response_close" | "request_aborted" | "upstream_error" | "timeout" | "local_abort";
const evidence = new WeakMap<object, { cancellationOrigin: FailureOrigin; cancellationEvidence: FailureEvidence }>();

/** Record at the causal boundary, before destroying the response. First evidence wins. */
export function recordResponseFailure(response: object, origin: FailureOrigin, reason: FailureEvidence) {
  if (!evidence.has(response)) evidence.set(response, { cancellationOrigin: origin, cancellationEvidence: reason });
}
export function recordUpstreamFailure(response: object, error: unknown, origin: "streamer" | "upstream" = "upstream") {
  const code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
  recordResponseFailure(response, code === "ETIMEDOUT" ? "timeout" : origin, code === "ETIMEDOUT" ? "timeout" : "upstream_error");
}
export function responseEvidence(response: object, aborted = false) {
  return evidence.get(response) || { cancellationOrigin: "unknown", cancellationEvidence: aborted ? "request_aborted" : "response_close" };
}
/** Only output representation length is comparable to response writes. */
export function expectedResponseBytes(method: string, status: number, length: unknown): number | undefined {
  if (method === "HEAD" || status === 204 || status === 304) return 0;
  if ((typeof length !== "string" && typeof length !== "number") || !/^\d+$/.test(String(length))) return undefined;
  const value = Number(length);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
