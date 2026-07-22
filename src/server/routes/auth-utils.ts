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
