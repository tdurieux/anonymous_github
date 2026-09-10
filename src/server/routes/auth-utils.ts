import * as express from "express";

export function isDisabledAccount(
  status: string | undefined
): status is "banned" | "removed" {
  return status === "banned" || status === "removed";
}

export function getLoginToken(
  req: Pick<express.Request, "headers" | "body">
): string | null {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }

  if (req.body && typeof req.body.token === "string") {
    return req.body.token.trim() || null;
  }
  return null;
}

export function safeAuthReturnTo(value: unknown, fallback = "/dashboard"): string {
  return typeof value === "string" && /^\/(?:(?:anonymize|pull-request-anonymize|gist-anonymize)(?:\/[\w-]+)?|connections|dashboard)(?:\?[^\\\r\n]*)?$/.test(value) ? value : fallback;
}

export type OAuthContext = { ownerId?: string; githubId?: string; returnTo: string; expires: number; recovery?: boolean };
declare module "express-session" {
  interface SessionData {
    githubRecovery?: OAuthContext;
    githubOAuthFlow?: OAuthContext;
  }
}
declare module "express-serve-static-core" {
  interface Request { githubOAuthContext?: OAuthContext; }
}
