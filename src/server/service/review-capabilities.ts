import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { RequestHandler } from "express";

const contract = "4open.artifacts/1";
const clientPattern = /^[a-f0-9]{32}$/;
const keyPattern = /^[A-Za-z0-9_-]{1,64}$/;
const secretPattern = /^[a-f0-9]{64}$/;
type Key = { clientId: string; digest: Buffer; from: number; until: number };

function invalid(): never {
  // Never include private configuration or request values in diagnostic errors.
  throw new Error("Invalid REVIEW_SERVICE_KEYS configuration");
}
function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== fields.length ||
    fields.some((k) => !Object.prototype.hasOwnProperty.call(data, k))
  )
    invalid();
  return data;
}
function timestamp(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(value)
  )
    invalid();
  const time = Date.parse(value);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== value.replace("Z", ".000Z")
  )
    invalid();
  return time;
}
function registry(raw: string): Map<string, Key> {
  if (Buffer.byteLength(raw, "utf8") > 65536) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid();
  }
  const config = record(parsed, ["version", "keys"]);
  if (
    config.version !== 1 ||
    !Array.isArray(config.keys) ||
    config.keys.length < 1 ||
    config.keys.length > 64
  )
    invalid();
  const keys = new Map<string, Key>(),
    digests = new Set<string>(),
    clients = new Map<string, number>();
  for (const entry of config.keys) {
    const k = record(entry, [
      "clientId",
      "keyId",
      "tokenSHA256",
      "notBefore",
      "notAfter",
    ]);
    if (
      typeof k.clientId !== "string" ||
      !clientPattern.test(k.clientId) ||
      typeof k.keyId !== "string" ||
      !keyPattern.test(k.keyId) ||
      typeof k.tokenSHA256 !== "string" ||
      !secretPattern.test(k.tokenSHA256)
    )
      invalid();
    const from = timestamp(k.notBefore),
      until = timestamp(k.notAfter);
    const id = k.clientId + ":" + k.keyId;
    const count = (clients.get(k.clientId) || 0) + 1;
    if (
      until <= from ||
      keys.has(id) ||
      digests.has(k.tokenSHA256) ||
      count > 16
    )
      invalid();
    clients.set(k.clientId, count);
    if (clients.size > 32) invalid();
    digests.add(k.tokenSHA256);
    keys.set(id, {
      clientId: k.clientId,
      digest: Buffer.from(k.tokenSHA256, "hex"),
      from,
      until,
    });
  }
  return keys;
}

/** Optional server-to-server read-only endpoint. No browser, owner or repository authority is inferred. */
export function createReviewCapabilities(
  raw?: string,
  now: () => number = Date.now,
): RequestHandler {
  const keys = raw === undefined ? null : registry(raw);
  // One bounded counter per registered client, shared by its rotation keys.
  const rates = new Map<string, { minute: number; count: number }>();
  const dummyDigest = Buffer.alloc(32);
  return (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const fail = (status: number, code: string, retry?: number) => {
      // Do not keep a rejected request alive while Node drains an unread body.
      res.setHeader("Connection", "close");
      if (retry) res.setHeader("Retry-After", String(retry));
      res.status(status).json({
        contract,
        code,
        requestId: randomBytes(16).toString("hex"),
        ...(retry ? { retryAfterSeconds: retry } : {}),
      });
    };
    if (!keys || req.originalUrl !== "/service/v1/capabilities")
      return fail(404, "not-found");
    if (req.method !== "GET") return fail(405, "invalid-request");
    // Reject browser context and bodies before authentication; never read or log them.
    if (
      [
        "cookie",
        "origin",
        "referer",
        "sec-fetch-site",
        "sec-fetch-mode",
        "sec-fetch-dest",
        "sec-fetch-user",
      ].some((h) => req.headers[h] !== undefined)
    )
      return fail(403, "forbidden");
    if (
      req.headers["transfer-encoding"] !== undefined ||
      req.headers["content-type"] !== undefined ||
      (req.headers["content-length"] !== undefined &&
        req.headers["content-length"] !== "0")
    )
      return fail(400, "invalid-request");
    const one = (name: string): string | undefined => {
      let count = 0;
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        if (req.rawHeaders[i].toLowerCase() === name) count++;
      const value = req.headers[name];
      return count === 1 && typeof value === "string" ? value : undefined;
    };
    const client = one("x-4open-artifact-client-id"),
      keyId = one("x-4open-artifact-service-key-id"),
      authorization = one("authorization");
    if (
      !client ||
      !clientPattern.test(client) ||
      !keyId ||
      !keyPattern.test(keyId) ||
      !authorization ||
      !/^Bearer [a-f0-9]{64}$/i.test(authorization) ||
      !secretPattern.test(authorization.slice(7))
    )
      return fail(401, "unauthorized");
    const key = keys.get(client + ":" + keyId);
    const digest = createHash("sha256")
      .update(authorization.slice(7), "ascii")
      .digest();
    const equal = timingSafeEqual(digest, key ? key.digest : dummyDigest);
    const time = now();
    if (
      !key ||
      !equal ||
      !Number.isFinite(time) ||
      time < key.from ||
      time >= key.until
    )
      return fail(401, "unauthorized");
    const minute = Math.floor(time / 60000);
    let rate = rates.get(client);
    if (!rate || rate.minute !== minute) {
      rate = { minute, count: 0 };
      rates.set(client, rate);
    }
    if (rate.count >= 60)
      return fail(
        429,
        "rate-limited",
        Math.max(1, Math.ceil((60000 - (time % 60000)) / 1000)),
      );
    rate.count++;
    // No link, snapshot, protected-delivery or retention support exists yet.
    res.status(200).json({
      contract,
      clientId: client,
      contracts: [contract],
      available: [],
    });
  };
}
