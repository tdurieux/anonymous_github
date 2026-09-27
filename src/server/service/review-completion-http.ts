import { randomBytes } from "crypto";
import { RequestHandler } from "express";
import {
  createReviewOwnerConsent,
  ReviewConsentError,
} from "./review-owner-consent";
import {
  createReviewServiceAuth,
  singleReviewHeader,
} from "./review-service-auth";
import { decodeReviewJSON } from "./review-json";

const contract = "4open.artifacts/1";
const opaque = /^[a-f0-9]{32}$/;
function exact(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys.sort().join(",")
  );
}
function receipt(value: unknown, clientId: string, intentId: string): unknown {
  if (
    !exact(value, [
      "contract",
      "clientId",
      "intentId",
      "bindingId",
      "submissionRef",
      "policy",
      "entitlementId",
    ]) ||
    value.contract !== contract ||
    value.clientId !== clientId ||
    value.intentId !== intentId ||
    ![value.bindingId, value.submissionRef, value.entitlementId].every(
      (id) => typeof id === "string" && opaque.test(id),
    ) ||
    !exact(value.policy, ["version", "access", "retainUntil"])
  )
    throw new Error("Invalid receipt");
  const policy = value.policy;
  if (
    !Number.isSafeInteger(policy.version) ||
    (policy.version as number) < 1 ||
    !["anonymous-link", "restricted-review"].includes(
      policy.access as string,
    ) ||
    typeof policy.retainUntil !== "string" ||
    !/^2[01][0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(
      policy.retainUntil,
    ) ||
    !Number.isFinite(Date.parse(policy.retainUntil)) ||
    new Date(policy.retainUntil).toISOString() !==
      policy.retainUntil.replace("Z", ".000Z")
  )
    throw new Error("Invalid receipt");
  return value;
}

/** Mount before global JSON parsing and browser authentication. Disabled without
 * its own scoped registry. This factory is intentionally not mounted at startup. */
export function createReviewCompletionService(
  raw: string | undefined,
  backend: Pick<
    ReturnType<typeof createReviewOwnerConsent>,
    "exchange" | "receipt"
  >,
  now: () => number = Date.now,
): RequestHandler {
  const auth =
    raw === undefined ? undefined : createReviewServiceAuth(raw, now);
  const rates = new Map<string, { minute: number; count: number }>();
  let active = 0;
  return async (req, res) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    res.removeHeader("Access-Control-Allow-Origin");
    const fail = (status: number, code: string) => {
      if (res.headersSent || res.destroyed) return;
      res.setHeader("Connection", "close");
      res
        .status(status)
        .json({ contract, code, requestId: randomBytes(16).toString("hex") });
    };
    const exchange = req.originalUrl === "/service/v1/completions/exchange";
    const read = /^\/service\/v1\/intents\/([a-f0-9]{32})\/receipt$/.exec(
      req.originalUrl,
    );
    if (!auth || (!exchange && !read)) return fail(404, "not-found");
    if (req.method !== (exchange ? "POST" : "GET"))
      return fail(405, "invalid-request");
    if (
      !req.secure ||
      [
        "cookie",
        "origin",
        "referer",
        "sec-fetch-site",
        "sec-fetch-mode",
        "sec-fetch-dest",
        "sec-fetch-user",
      ].some((name) => req.headers[name] !== undefined)
    )
      return fail(403, "forbidden");
    if (req.body !== undefined) return fail(503, "unavailable");
    if (req.headers["content-encoding"] !== undefined)
      return fail(400, "invalid-request");
    for (const name of ["content-type", "content-length", "transfer-encoding"])
      if (
        req.headers[name] !== undefined &&
        singleReviewHeader(req, name) === undefined
      )
        return fail(400, "invalid-request");
    if (exchange) {
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          singleReviewHeader(req, "content-type") || "",
        )
      )
        return fail(400, "invalid-request");
      const length = req.headers["content-length"];
      if (
        length !== undefined &&
        (!/^\d+$/.test(String(length)) || Number(length) > 65536)
      )
        return fail(400, "invalid-request");
    } else if (
      req.headers["transfer-encoding"] !== undefined ||
      req.headers["content-type"] !== undefined ||
      (req.headers["content-length"] !== undefined &&
        req.headers["content-length"] !== "0")
    )
      return fail(400, "invalid-request");
    const principal = auth.authenticate(
      req,
      exchange ? "completion.exchange" : "receipt.read",
    );
    if (!principal) return fail(401, "unauthorized");
    const minute = Math.floor(now() / 60000);
    let rate = rates.get(principal.clientId);
    if (!rate || rate.minute !== minute) {
      rate = { minute, count: 0 };
      rates.set(principal.clientId, rate);
    }
    if (rate.count++ >= 60) return fail(429, "rate-limited");
    if (active >= 4) return fail(503, "unavailable");
    active++;
    let cancelBody: (() => void) | undefined;
    let ended = false;
    const close = () => {
      ended = true;
      cancelBody?.();
    };
    res.once("close", close);
    const timer = setTimeout(() => {
      ended = true;
      fail(503, "unavailable");
      cancelBody?.();
    }, 15000);
    try {
      let intentId = read?.[1] || "";
      let result: unknown;
      if (exchange) {
        const bytes = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const cleanup = () => {
            req.off("data", data);
            req.off("end", end);
            req.off("aborted", abort);
            req.off("error", abort);
            cancelBody = undefined;
          };
          const abort = () => {
            cleanup();
            reject(new Error("Request unavailable"));
          };
          const data = (chunk: Buffer) => {
            size += chunk.length;
            if (size > 65536) {
              fail(400, "invalid-request");
              abort();
            } else chunks.push(chunk);
          };
          const end = () => {
            cleanup();
            resolve(Buffer.concat(chunks));
          };
          cancelBody = abort;
          req.on("data", data);
          req.once("end", end);
          req.once("aborted", abort);
          req.once("error", abort);
        });
        if (ended) return;
        let command: unknown;
        try {
          command = decodeReviewJSON(bytes);
        } catch {
          return fail(400, "invalid-request");
        }
        if (
          !exact(command, [
            "contract",
            "clientId",
            "intentId",
            "code",
            "requestId",
          ]) ||
          typeof command.contract !== "string" ||
          ![command.clientId, command.intentId, command.requestId].every(
            (id) => typeof id === "string" && opaque.test(id),
          ) ||
          typeof command.code !== "string" ||
          !/^[a-f0-9]{64}$/.test(command.code)
        )
          return fail(400, "invalid-request");
        if (command.contract !== contract)
          return fail(422, "unsupported-version");
        if (command.clientId !== principal.clientId)
          return fail(403, "forbidden");
        if (!principal.valid()) return fail(401, "unauthorized");
        intentId = command.intentId as string;
        result = await backend.exchange(
          principal.clientId,
          command as Parameters<typeof backend.exchange>[1],
        );
      } else {
        if (!principal.valid()) return fail(401, "unauthorized");
        result = await backend.receipt(principal.clientId, intentId);
      }
      if (ended) return;
      if (!principal.valid()) return fail(401, "unauthorized");
      res.status(200).json(receipt(result, principal.clientId, intentId));
    } catch (error) {
      if (ended) return;
      if (error instanceof ReviewConsentError) {
        const codes = {
          invalid: [400, "invalid-request"],
          forbidden: [403, "forbidden"],
          expired: [410, "expired"],
          conflict: [409, "conflict"],
          unavailable: [503, "unavailable"],
        } as const;
        const [status, code] = codes[error.kind];
        fail(status, code);
      } else fail(503, "unavailable");
    } finally {
      clearTimeout(timer);
      res.off("close", close);
      active--;
    }
  };
}
