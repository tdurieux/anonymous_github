/** Suppress only transport cancellation after the downstream has gone away. */
export function isResponseCancellation(error: unknown, response?: { destroyed?: boolean; req?: { aborted?: boolean } }): boolean {
  if (!response?.destroyed) return false;
  const seen = new Set<unknown>();
  for (let value = error; value && typeof value === "object" && !seen.has(value);) {
    seen.add(value);
    const item = value as { code?: string; message?: string; cause?: unknown };
    if (item.message === "response_cancelled") return true;
    // pipeline also destroys the response on upstream failure. A destroyed
    // response alone does not prove that a premature close was client-driven.
    if (response.req?.aborted && (item.code === "ERR_STREAM_PREMATURE_CLOSE" ||
        item.code === "ABORT_ERR")) return true;
    value = item.cause;
  }
  return false;
}
