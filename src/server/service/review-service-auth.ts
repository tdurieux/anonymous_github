import { createHash, timingSafeEqual } from "crypto";
import { Request } from "express";
import { decodeReviewJSON } from "./review-json";

type Scope = "completion.exchange" | "receipt.read";
type Key = {
  clientId: string;
  digest: Buffer;
  from: number;
  until: number;
  scopes: Scope[];
};
const opaque = /^[a-f0-9]{32}$/;
const secret = /^[a-f0-9]{64}$/;
const invalid = (): never => {
  throw new Error("Invalid review exchange credentials");
};
function fields(value: unknown, names: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== names.sort().join(",")
  )
    return invalid();
  return value as Record<string, unknown>;
}
function date(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(value)
  )
    return invalid();
  const number = Date.parse(value);
  if (
    !Number.isFinite(number) ||
    new Date(number).toISOString() !== value.replace("Z", ".000Z")
  )
    return invalid();
  return number;
}
export function singleReviewHeader(
  req: Request,
  name: string,
): string | undefined {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    if (req.rawHeaders[i].toLowerCase() === name) count++;
  const value = req.headers[name];
  return count === 1 && typeof value === "string" ? value : undefined;
}

/** Separate scoped registry: the capabilities-only registry is not accepted. */
export function createReviewServiceAuth(
  raw: string,
  now: () => number = Date.now,
) {
  let parsed: unknown;
  try {
    parsed = decodeReviewJSON(Buffer.from(raw, "utf8"));
  } catch {
    return invalid();
  }
  const config = fields(parsed, ["version", "keys"]);
  if (
    config.version !== 1 ||
    !Array.isArray(config.keys) ||
    config.keys.length < 1 ||
    config.keys.length > 64
  )
    return invalid();
  const keys = new Map<string, Key>(),
    digests = new Set<string>(),
    clients = new Map<string, number>();
  for (const entry of config.keys) {
    const k = fields(entry, [
      "clientId",
      "keyId",
      "tokenSHA256",
      "notBefore",
      "notAfter",
      "scopes",
    ]);
    if (
      typeof k.clientId !== "string" ||
      !opaque.test(k.clientId) ||
      typeof k.keyId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(k.keyId) ||
      typeof k.tokenSHA256 !== "string" ||
      !secret.test(k.tokenSHA256) ||
      !Array.isArray(k.scopes) ||
      k.scopes.length < 1 ||
      k.scopes.length > 2 ||
      k.scopes.some(
        (scope) => scope !== "completion.exchange" && scope !== "receipt.read",
      ) ||
      new Set(k.scopes).size !== k.scopes.length
    )
      return invalid();
    const from = date(k.notBefore),
      until = date(k.notAfter),
      id = k.clientId + ":" + k.keyId;
    const count = (clients.get(k.clientId) || 0) + 1;
    if (
      until <= from ||
      keys.has(id) ||
      digests.has(k.tokenSHA256) ||
      count > 16
    )
      return invalid();
    clients.set(k.clientId, count);
    if (clients.size > 32) return invalid();
    digests.add(k.tokenSHA256);
    keys.set(id, {
      clientId: k.clientId,
      digest: Buffer.from(k.tokenSHA256, "hex"),
      from,
      until,
      scopes: [...k.scopes] as Scope[],
    });
  }
  const dummy = Buffer.alloc(32);
  return Object.freeze({
    authenticate(
      req: Request,
      scope: Scope,
    ): { clientId: string; valid: () => boolean } | undefined {
      const client = singleReviewHeader(req, "x-4open-artifact-client-id"),
        keyId = singleReviewHeader(req, "x-4open-artifact-service-key-id"),
        authorization = singleReviewHeader(req, "authorization");
      if (
        !client ||
        !opaque.test(client) ||
        !keyId ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(keyId) ||
        !authorization ||
        !/^Bearer [a-f0-9]{64}$/i.test(authorization) ||
        !secret.test(authorization.slice(7))
      )
        return undefined;
      const key = keys.get(client + ":" + keyId);
      const matches = timingSafeEqual(
        createHash("sha256").update(authorization.slice(7), "ascii").digest(),
        key?.digest || dummy,
      );
      const valid = () => {
        const time = now();
        return (
          !!key &&
          matches &&
          key.scopes.includes(scope) &&
          Number.isFinite(time) &&
          time >= key.from &&
          time < key.until
        );
      };
      return valid() ? Object.freeze({ clientId: client, valid }) : undefined;
    },
  });
}
