import { decodeReviewJSON } from "./review-json";
import * as https from "https";
import { ClientRequest } from "http";

const contract = "4open.artifacts/1",
  limit = 65536;
const opaque = /^[a-f0-9]{32}$/,
  secret = /^[a-f0-9]{64}$/;
export type IntentClientFailure =
  | "invalid"
  | "busy"
  | "unavailable"
  | "rejected"
  | "conflict"
  | "expired"
  | "not-found"
  | "protocol";
export class IntentClientError extends Error {
  constructor(public readonly kind: IntentClientFailure) {
    super("Review intent consumption " + kind);
    this.name = "IntentClientError";
  }
}
export interface ReviewIntentClientConfig {
  origin: string;
  clientId: string;
  keyId: string;
  token: string;
  notBefore: string;
  notAfter: string;
}
export interface IntentConsumption {
  contract: string;
  clientId: string;
  intentId: string;
  token: string;
  requestId: string;
}
export type ConsumedReviewIntent = Readonly<{
  contract: string;
  clientId: string;
  intentId: string;
  submissionRef: string;
  callbackId: string;
  entitlementId: string;
  expiresAt: string;
  policy: Readonly<{
    version: number;
    access: "anonymous-link" | "restricted-review";
    retainUntil: string;
  }>;
}>;
function fail(kind: IntentClientFailure): never {
  throw new IntentClientError(kind);
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("protocol");
  const out = value as Record<string, unknown>;
  if (
    Object.keys(out).length !== fields.length ||
    fields.some((k) => !Object.prototype.hasOwnProperty.call(out, k))
  )
    fail("protocol");
  return out;
}
function instant(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^2[01][0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(value)
  )
    fail("protocol");
  const time = Date.parse(value);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== value.replace("Z", ".000Z")
  )
    fail("protocol");
  return time;
}
function id(value: unknown): value is string {
  return typeof value === "string" && opaque.test(value);
}

function decode(bytes: Buffer): unknown {
  try {
    return decodeReviewJSON(bytes);
  } catch {
    return fail("protocol");
  }
}

function intent(
  bytes: Buffer,
  clientId: string,
  intentId: string,
): ConsumedReviewIntent {
  const p = object(decode(bytes), [
    "contract",
    "clientId",
    "intentId",
    "submissionRef",
    "callbackId",
    "policy",
    "expiresAt",
    "entitlementId",
  ]);
  const policy = object(p.policy, ["version", "access", "retainUntil"]),
    now = Date.now();
  if (
    p.contract !== contract ||
    p.clientId !== clientId ||
    p.intentId !== intentId ||
    !id(p.submissionRef) ||
    !id(p.callbackId) ||
    !id(p.entitlementId)
  )
    fail("protocol");
  if (
    !Number.isSafeInteger(policy.version) ||
    (policy.version as number) < 1 ||
    (policy.access !== "anonymous-link" &&
      policy.access !== "restricted-review") ||
    instant(policy.retainUntil) <= now
  )
    fail("protocol");
  const expires = instant(p.expiresAt);
  if (expires <= now || expires > now + 600000) fail("protocol");
  return Object.freeze({
    contract,
    clientId,
    intentId,
    submissionRef: p.submissionRef,
    callbackId: p.callbackId,
    entitlementId: p.entitlementId,
    expiresAt: p.expiresAt as string,
    policy: Object.freeze({
      version: policy.version as number,
      access: policy.access as "anonymous-link" | "restricted-review",
      retainUntil: policy.retainUntil as string,
    }),
  });
}

/** Trusted server configuration only. One attempt per call; the caller retains
 * its request ID for an explicit retry. No browser callback or owner authority
 * is established by consuming an intent. No credentials are exposed on the
 * returned object, through serialization, or in transport errors. */
export function createReviewIntentConsumer(config: ReviewIntentClientConfig) {
  let origin: string,
    clientId: string,
    keyId: string,
    token: string,
    from: number,
    until: number;
  try {
    const c = object(config, [
      "origin",
      "clientId",
      "keyId",
      "token",
      "notBefore",
      "notAfter",
    ]);
    if (
      typeof c.origin !== "string" ||
      c.origin.length > 2048 ||
      !id(c.clientId) ||
      typeof c.keyId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(c.keyId) ||
      typeof c.token !== "string" ||
      !secret.test(c.token)
    )
      fail("invalid");
    const url = new URL(c.origin);
    if (
      url.protocol !== "https:" ||
      url.origin !== c.origin ||
      url.username ||
      url.password
    )
      fail("invalid");
    origin = c.origin;
    clientId = c.clientId;
    keyId = c.keyId;
    token = c.token;
    from = instant(c.notBefore);
    until = instant(c.notAfter);
    if (until <= from || Date.now() < from || Date.now() >= until)
      fail("invalid");
  } catch {
    return fail("invalid");
  }
  let active = 0;
  return Object.freeze({
    consume(
      input: IntentConsumption,
      signal?: AbortSignal,
    ): Promise<ConsumedReviewIntent> {
      let body: Buffer, expectedIntent: string;
      try {
        const p = object(input, [
          "contract",
          "clientId",
          "intentId",
          "token",
          "requestId",
        ]);
        if (
          p.contract !== contract ||
          p.clientId !== clientId ||
          !id(p.intentId) ||
          !id(p.requestId) ||
          typeof p.token !== "string" ||
          !secret.test(p.token) ||
          Date.now() < from ||
          Date.now() >= until
        )
          fail("invalid");
        expectedIntent = p.intentId;
        body = Buffer.from(
          JSON.stringify({
            contract,
            clientId,
            intentId: expectedIntent,
            token: p.token,
            requestId: p.requestId,
          }),
        );
      } catch {
        return Promise.reject(new IntentClientError("invalid"));
      }
      if (signal?.aborted)
        return Promise.reject(new IntentClientError("unavailable"));
      if (active >= 4) return Promise.reject(new IntentClientError("busy"));
      active++;
      return new Promise((resolve, reject) => {
        let request: ClientRequest | undefined,
          settled = false;
        const abort = () => finish("unavailable");
        const timer = setTimeout(abort, 10000);
        function finish(
          error?: IntentClientFailure,
          value?: ConsumedReviewIntent,
        ) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          active--;
          if (error) {
            request?.destroy();
            reject(new IntentClientError(error));
          } else resolve(value!);
        }
        signal?.addEventListener("abort", abort, { once: true });
        try {
          request = https.request(
            origin + "/service/v1/artifact-intents/consume",
            {
              method: "POST",
              agent: false,
              rejectUnauthorized: true,
              minVersion: "TLSv1.2",
              maxHeaderSize: 16384,
              headers: {
                Authorization: "Bearer " + token,
                "X-4open-Artifact-Client-Id": clientId,
                "X-4open-Artifact-Service-Key-Id": keyId,
                "Content-Type": "application/json",
                Accept: "application/json",
                "Accept-Encoding": "identity",
                "Content-Length": body.length,
              },
            },
            (response) => {
              response.once("aborted", abort);
              response.once("error", abort);
              const status = response.statusCode || 0;
              if (status !== 200) {
                const kind: IntentClientFailure =
                  status === 404
                    ? "not-found"
                    : status === 409
                      ? "conflict"
                      : status === 410
                        ? "expired"
                        : [400, 401, 403, 422].includes(status)
                          ? "rejected"
                          : [408, 429, 500, 502, 503, 504].includes(status)
                            ? "unavailable"
                            : "protocol";
                finish(kind);
                return;
              }
              const types = response.rawHeaders.filter(
                (_v, i) =>
                  i % 2 === 0 &&
                  response.rawHeaders[i].toLowerCase() === "content-type",
              ).length;
              const length = response.headers["content-length"];
              if (
                types !== 1 ||
                !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(
                  response.headers["content-type"] || "",
                ) ||
                response.headers["content-encoding"] !== undefined ||
                response.headers["set-cookie"] !== undefined ||
                (length !== undefined &&
                  (!/^[0-9]+$/.test(length) || Number(length) > limit))
              ) {
                finish("protocol");
                return;
              }
              let size = 0;
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > limit) finish("protocol");
                else if (!settled) chunks.push(chunk);
              });
              response.once("end", () => {
                if (settled) return;
                if (
                  signal?.aborted ||
                  Date.now() < from ||
                  Date.now() >= until
                ) {
                  finish("unavailable");
                  return;
                }
                try {
                  finish(
                    undefined,
                    intent(
                      Buffer.concat(chunks, size),
                      clientId,
                      expectedIntent,
                    ),
                  );
                } catch {
                  finish("protocol");
                }
              });
            },
          );
          request.once("error", abort);
          request.setTimeout(5000, abort);
          if (signal?.aborted) abort();
          if (!settled) request.end(body);
        } catch {
          finish("unavailable");
        }
      });
    },
  });
}
