import rateLimit, { Store } from "express-rate-limit";
import config from "../config";
import { requestRateLimitKey } from "./rate-limit-key";
import { sendRequestRateLimit } from "./request-rate-limit";

/** A page's images and scripts must not consume its visitor's API budget. */
export function createWebsiteRateLimiter(store?: Store) {
  if (!Number.isSafeInteger(config.WEBSITE_RATE_LIMIT) || config.WEBSITE_RATE_LIMIT <= 0) {
    throw new Error("WEBSITE_RATE_LIMIT must be a positive integer");
  }
  return rateLimit({
    windowMs: 15 * 60_000,
    limit: config.WEBSITE_RATE_LIMIT,
    keyGenerator: requestRateLimitKey,
    standardHeaders: "draft-6",
    legacyHeaders: false,
    handler: sendRequestRateLimit,
    ...(store ? { store } : {}),
  });
}
