import { Request, Response } from "express";

/** Give clients a retry time instead of an unparseable plain-text failure. */
export function sendRequestRateLimit(req: Request, res: Response) {
  const rate = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit;
  const resetAt = rate?.resetTime?.getTime() || Date.now() + 15 * 60_000;
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))));
  res.status(429).json({ error: "rate_limited", resetAt });
}
