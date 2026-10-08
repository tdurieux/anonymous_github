import { decodeReviewJSON } from "./review-json";
const invalid = (): never => { throw new Error("Invalid review callback registry"); };
export function createReviewCallbacks(raw: string) {
  let value: unknown;
  try { value = decodeReviewJSON(Buffer.from(raw, "utf8")); } catch { return invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "callbacks,version") return invalid();
  const config = value as { version: unknown; callbacks: unknown };
  if (config.version !== 1 || !Array.isArray(config.callbacks) || !config.callbacks.length || config.callbacks.length > 32) return invalid();
  const callbacks = new Map<string, string>(), destinations = new Set<string>();
  for (const item of config.callbacks) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join(",") !== "callbackId,clientId,url") return invalid();
    const { clientId, callbackId, url } = item;
    if (![clientId, callbackId].every(id => typeof id === "string" && /^[a-f0-9]{32}$/.test(id)) || typeof url !== "string" || url.length > 2048) return invalid();
    let parsed: URL;
    try { parsed = new URL(url); } catch { return invalid(); }
    if (parsed.protocol !== "https:" || parsed.href !== url || parsed.username || parsed.password || parsed.search || parsed.hash || url.includes("?") || url.includes("#") || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(parsed.pathname)) return invalid();
    const key = clientId + ":" + callbackId;
    if (callbacks.has(key)) return invalid();
    callbacks.set(key, url); destinations.add(url);
  }
  const formAction = "'self' " + [...destinations].join(" ");
  if (Buffer.byteLength(formAction) > 4096) return invalid();
  return Object.freeze({
    formAction,
    resolve(clientId: string, callbackId: string): string | undefined { return callbacks.get(clientId + ":" + callbackId); },
  });
}
export type ReviewCallbacks = ReturnType<typeof createReviewCallbacks>;
