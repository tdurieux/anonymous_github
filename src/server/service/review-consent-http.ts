import { createHmac, timingSafeEqual } from "crypto";
import * as express from "express";
import { Request, Response } from "express";
import { createReviewOwnerConsent } from "./review-owner-consent";

type BrowserSession = { passport?: { user?: unknown } };
type Context = { accountId: string; sessionId: string };
const opaque = /^[a-f0-9]{32}$/;
const secret = /^[a-f0-9]{64}$/;
function fields(
  value: unknown,
  names: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === names.sort().join(",")
  );
}
function reject(res: Response, status: number, code: string) {
  if (!res.headersSent && !res.destroyed) res.setHeader("Connection", "close");
  if (!res.headersSent && !res.destroyed)
    res.status(status).json({ error: { code } });
}
async function current(req: Request): Promise<Context | undefined> {
  const id = (req.user as { user?: { _id?: unknown } } | undefined)?.user?._id;
  const accountId = id === undefined ? "" : String(id);
  if (
    !req.isAuthenticated?.() ||
    !/^[a-f0-9]{24}$/.test(accountId) ||
    !/^[A-Za-z0-9_-]{24,256}$/.test(req.sessionID || "")
  )
    return undefined;
  const session = await new Promise<BrowserSession | undefined>(
    (resolve, fail) =>
      req.sessionStore.get(req.sessionID, (error, value) =>
        error
          ? fail(new Error("Session unavailable"))
          : resolve(value as BrowserSession | undefined),
      ),
  );
  if (session?.passport?.user !== accountId) return undefined;
  return { accountId, sessionId: req.sessionID };
}

/** Mount after current Passport/session authentication and BEFORE any JSON
 * parser. This factory is not registered by application startup. TLS must be
 * established directly or identified through the configured trusted proxy. */
export function createReviewConsentRouter(
  origin: string,
  backend: ReturnType<typeof createReviewOwnerConsent>,
  csrfKey: Buffer,
) {
  try {
    if (new URL(origin).origin !== origin || !origin.startsWith("https://"))
      throw new Error();
  } catch {
    throw new Error("Invalid review consent origin");
  }
  if (!Buffer.isBuffer(csrfKey) || csrfKey.length !== 32)
    throw new Error("Invalid review consent CSRF key");
  const key = Buffer.from(csrfKey);
  const csrf = (actor: Context) =>
    createHmac("sha256", key)
      .update(
        "4open.review-consent-csrf/1." +
          actor.accountId +
          "." +
          actor.sessionId,
      )
      .digest();
  const router = express.Router({ strict: true, caseSensitive: true });
  const rates = new Map<string, { until: number; count: number }>();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.removeHeader("Access-Control-Allow-Origin");
    if (!["/csrf", "/preview", "/confirm"].includes(req.url))
      return reject(res, 404, "not-found");
    if (req.method !== (req.url === "/csrf" ? "GET" : "POST"))
      return reject(res, 405, "invalid-request");
    if (
      req.url === "/csrf" &&
      (req.headers["transfer-encoding"] !== undefined ||
        (req.headers["content-length"] !== undefined &&
          req.headers["content-length"] !== "0"))
    )
      return reject(res, 400, "invalid-request");
    if (
      !req.secure ||
      req.headers.authorization !== undefined ||
      req.headers["content-encoding"] !== undefined
    )
      return reject(res, 403, "forbidden");
    for (const name of [
      "origin",
      "content-type",
      "x-review-csrf",
      "sec-fetch-site",
    ]) {
      if (
        req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === name)
          .length > 1
      )
        return reject(res, 403, "forbidden");
    }
    if (
      (req.headers.origin !== undefined && req.headers.origin !== origin) ||
      (req.method === "POST" && req.headers.origin !== origin) ||
      (req.headers["sec-fetch-site"] !== undefined &&
        req.headers["sec-fetch-site"] !== "same-origin")
    )
      return reject(res, 403, "forbidden");
    if (
      req.method === "POST" &&
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        req.headers["content-type"] || "",
      )
    )
      return reject(res, 415, "invalid-request");
    // Fail closed if mounted after a body parser that bypassed our byte limit.
    if (req.body !== undefined) return reject(res, 503, "unavailable");
    const controller = new AbortController();
    res.locals.consentSignal = controller.signal;
    const timer = setTimeout(() => {
      controller.abort();
      reject(res, 408, "expired");
      req.destroy();
    }, 15000);
    const done = () => {
      clearTimeout(timer);
      controller.abort();
    };
    res.once("close", done);
    res.once("finish", done);
    next();
  });
  router.use(async (req, res, next) => {
    try {
      const actor = await current(req);
      if (res.destroyed || res.headersSent || res.locals.consentSignal.aborted)
        return;
      if (!actor) return reject(res, 401, "unauthorized");
      if (req.method === "POST") {
        const supplied = req.headers["x-review-csrf"];
        if (
          typeof supplied !== "string" ||
          !secret.test(supplied) ||
          !timingSafeEqual(Buffer.from(supplied, "hex"), csrf(actor))
        )
          return reject(res, 403, "forbidden");
      }
      const now = Date.now();
      for (const [id, rate] of rates) if (rate.until <= now) rates.delete(id);
      const rate = rates.get(actor.accountId) || {
        until: now + 60000,
        count: 0,
      };
      if (
        rate.count >= 60 ||
        (!rates.has(actor.accountId) && rates.size >= 1024)
      ) {
        res.setHeader("Retry-After", "60");
        return reject(res, 429, "rate-limited");
      }
      rate.count++;
      rates.set(actor.accountId, rate);
      res.locals.consentActor = actor;
      next();
    } catch {
      reject(res, 503, "unavailable");
    }
  });
  router.get("/csrf", async (req, res) => {
    try {
      const fresh = await current(req);
      if (!fresh || fresh.accountId !== res.locals.consentActor.accountId)
        return reject(res, 401, "unauthorized");
      // Derive without saving the session: a late CSRF response must never
      // resurrect a session that a concurrent logout has destroyed.
      res.json({ csrf: csrf(fresh).toString("hex") });
    } catch {
      reject(res, 503, "unavailable");
    }
  });
  router.use(express.json({ limit: 12288, strict: true, inflate: false }));
  // Uploads can outlive the session checked before body parsing. Revalidate
  // before any provider call or consent write, not only before the response.
  router.use(async (req, res, next) => {
    try {
      const actor = res.locals.consentActor as Context;
      const fresh = await current(req);
      if (res.destroyed || res.headersSent || res.locals.consentSignal.aborted)
        return;
      if (
        !fresh ||
        fresh.accountId !== actor.accountId ||
        fresh.sessionId !== actor.sessionId
      )
        return reject(res, 401, "unauthorized");
      next();
    } catch {
      reject(res, 503, "unavailable");
    }
  });
  router.post(["/preview", "/confirm"], async (req, res) => {
    const actor = res.locals.consentActor as Context;
    try {
      let result: unknown;
      if (req.url === "/preview") {
        if (
          !fields(req.body, ["repositoryId", "intent"]) ||
          typeof req.body.repositoryId !== "string" ||
          !/^[A-Za-z0-9_-]{3,128}$/.test(req.body.repositoryId) ||
          !fields(req.body.intent, [
            "contract",
            "clientId",
            "intentId",
            "token",
            "requestId",
          ])
        )
          return reject(res, 422, "invalid-request");
        const input = req.body.intent;
        if (
          input.contract !== "4open.artifacts/1" ||
          ![input.clientId, input.intentId, input.requestId].every(
            (v) => typeof v === "string" && opaque.test(v),
          ) ||
          typeof input.token !== "string" ||
          !secret.test(input.token)
        )
          return reject(res, 422, "invalid-request");
        const preview = await backend.preview(
          actor,
          req.body.repositoryId,
          {
            contract: input.contract,
            clientId: input.clientId as string,
            intentId: input.intentId as string,
            requestId: input.requestId as string,
            token: input.token,
          },
          res.locals.consentSignal,
        );
        result = {
          ticket: preview.ticket,
          repositoryName: preview.repositoryName,
          policy: {
            version: preview.policy.version,
            access: preview.policy.access,
            retainUntil: preview.policy.retainUntil,
          },
          expiresAt: preview.expiresAt,
        };
      } else {
        if (
          !fields(req.body, [
            "ticket",
            "requestId",
            "acceptAccess",
            "acceptRetention",
          ]) ||
          typeof req.body.ticket !== "string" ||
          req.body.ticket.length > 8192 ||
          typeof req.body.requestId !== "string" ||
          !opaque.test(req.body.requestId) ||
          req.body.acceptAccess !== true ||
          req.body.acceptRetention !== true
        )
          return reject(res, 422, "invalid-request");
        const saved = await backend.confirm(actor, req.body.ticket, {
          requestId: req.body.requestId,
          acceptAccess: true,
          acceptRetention: true,
        });
        result = {
          requestId: saved.requestId,
          policy: {
            version: saved.policy.version,
            access: saved.policy.access,
            retainUntil: saved.policy.retainUntil,
          },
          confirmedAt: saved.confirmedAt,
        };
      }
      const fresh = await current(req);
      if (
        !fresh ||
        fresh.accountId !== actor.accountId ||
        fresh.sessionId !== actor.sessionId
      )
        return reject(res, 401, "unauthorized");
      if (!res.headersSent && !res.destroyed) res.json(result);
    } catch (error) {
      const kind = (error as { kind?: string })?.kind;
      const status =
        kind === "invalid" || kind === "protocol"
          ? 422
          : kind === "forbidden" || kind === "rejected"
            ? 403
            : kind === "expired"
              ? 410
              : kind === "conflict"
                ? 409
                : 503;
      reject(
        res,
        status,
        status === 503
          ? "unavailable"
          : status === 422
            ? "invalid-request"
            : kind!,
      );
    }
  });
  router.use(((error, _req, res, _next) =>
    reject(
      res,
      error?.status === 413 ? 413 : 400,
      "invalid-request",
    )) as express.ErrorRequestHandler);
  return router;
}
