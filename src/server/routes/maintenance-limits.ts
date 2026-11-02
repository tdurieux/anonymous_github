import { Options } from "express-rate-limit";
import { requestRateLimitKey } from "../rate-limit-key";

// Redis stores are supplied by the server. These policies also run in tests
// with the in-memory store, through real HTTP requests and the auth middleware.
export const tokenAttemptLimitOptions: Partial<Options> = {
  windowMs: 60_000,
  limit: 120,
  skip: req => !req.headers.authorization,
  keyGenerator: requestRateLimitKey,
  standardHeaders: "draft-6",
  legacyHeaders: false,
  message: { error: "token_attempts_rate_limited" },
};

export const maintenanceRefreshLimitOptions: Partial<Options> = {
  windowMs: 60_000,
  limit: 1,
  skip: (req, res) => !res.locals.maintenanceToken || req.method !== "POST" ||
    !/^\/api\/repo\/[a-zA-Z0-9_-]+\/refresh\/?$/.test(req.path),
  // Share the cooldown across this account's tokens and client IPs. Keep
  // different accounts separate so a removed coauthor cannot block the owner.
  keyGenerator: (req, res) =>
    `${res.locals.maintenanceOwnerId}:${req.path.split("/")[3].toLowerCase()}`,
  standardHeaders: "draft-6",
  legacyHeaders: false,
  message: { error: "refresh_rate_limited" },
};
