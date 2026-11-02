import { ReviewCallbacks } from "./service/review-callbacks";
import { Request, Response } from "express";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

// Reserve aliases too: they must never fall through to the ordinary page,
// which loads third-party scripts. Only the canonical URL serves this page.
export function isReviewConsentPagePath(path: string): boolean {
  try {
    return (
      decodeURIComponent(path).toLowerCase().replace(/\/+$/, "") ===
      "/review-link"
    );
  } catch {
    return false;
  }
}

export function createReviewConsentPage(
  manifestPath = resolve("public", "asset-manifest.json"),
  callbacks?: ReviewCallbacks,
) {
  return (req: Request, res: Response): void => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action " + (callbacks?.formAction || "'self'") + "; frame-ancestors 'none'",
    });
    if (
      req.originalUrl !== "/review-link" ||
      (req.method !== "GET" && req.method !== "HEAD")
    ) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    let manifest: Record<string, unknown> = {};
    try {
      if (existsSync(manifestPath)) {
        const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          manifest = parsed as Record<string, unknown>;
      }
    } catch {
      // A missing or malformed manifest uses the ordinary unhashed assets.
    }
    const asset = (name: string): string => {
      const value = manifest[name];
      const extension = name.endsWith(".js") ? "js" : "css";
      return typeof value === "string" &&
        new RegExp(`^[A-Za-z0-9][A-Za-z0-9_.-]*\\.${extension}$`).test(value)
        ? value
        : name;
    };
    res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="review-consent-page" content="1"><title>Artifact consent · Anonymous GitHub</title><link rel="stylesheet" href="/css/${asset("all.min.css")}"></head><body><div id="app"></div><script src="/script/${asset("core.min.js")}"></script><script defer src="/script/${asset("vendor.min.js")}"></script></body></html>`);
  };
}
