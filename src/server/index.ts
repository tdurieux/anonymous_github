import { sendRequestRateLimit } from "./request-rate-limit";
import { installFatalErrorLogging } from "../core/process-monitoring";
import { githubAppRouter, githubAppWebhook } from "./routes/github-app";
import { config as dotenv } from "dotenv";
dotenv();

import { createClient } from "redis";
import { resolve, join, sep } from "path";
import { existsSync, readFileSync } from "fs";
import rateLimit from "express-rate-limit";
import { slowDown } from "express-slow-down";
import RedisStore from "rate-limit-redis";
import * as express from "express";
import * as compression from "compression";
import * as passport from "passport";
import { connect } from "./database";
import { startTemporaryStorageMaintenance } from "../core/temporary-storage";
import { initSession, router as connectionRouter } from "./routes/connection";
import { bearerTokenAuth } from "./routes/token-auth";
import router from "./routes";
import {
  conferenceStatusCheck,
  repositoryStatusCheck,
  runRepositoryStatusCheck,
  dailyStatsSnapshot,
} from "./schedule";
import {
  startWorker,
  recoverStuckPreparing,
  recoverStuckRemoving,
} from "../queue";
import {
  getCurrentStats,
  getStatsHistory,
  ensureTodaySnapshot,
} from "./dailyStatsSnapshot";
import { getUser } from "./routes/route-utils";
import config from "../config";
import { resolveTrustProxy } from "./trustProxy";
import { requestRateLimitKey } from "./rate-limit-key";
import { createLogger, serializeError } from "../core/logger";
import { monitorRequests } from "../core/request-monitoring";
import { startPerformanceMonitoring } from "../core/performance-monitoring";
import { getAnonymizationPoolStats } from "../core/anonymization-pool";

import { createReviewCapabilities } from "./service/review-capabilities";

import { createReviewConsentPage, isReviewConsentPagePath } from "./review-consent-page";

const reviewConsentPage = createReviewConsentPage();
const logger = createLogger("server");
installFatalErrorLogging("api");

// Lazily build the templated index.html on first request so the server
// works even when started before `gulp` finishes.
const indexHtmlPath = resolve("public", "index.html");
const manifestPath = resolve("public", "asset-manifest.json");
let indexHtmlCache: string | null = null;

function getIndexHtml(): string {
  if (indexHtmlCache) return indexHtmlCache;

  let assetManifest: Record<string, string> = {};
  if (existsSync(manifestPath)) {
    try {
      assetManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      // manifest missing or malformed — fall back to unhashed names
    }
  }
  function asset(name: string): string {
    return assetManifest[name] || name;
  }

  let html = existsSync(indexHtmlPath)
    ? readFileSync(indexHtmlPath, "utf-8")
    : "";

  html = html
    .replace("__CORE_JS__", asset("core.min.js"))
    .replace("__VENDOR_JS__", asset("vendor.min.js"))
    .replace("__MERMAID_JS__", asset("mermaid.min.js"))
    .replace("__ALL_CSS__", asset("all.min.css"));
  indexHtmlCache = html;
  return html;
}

function indexResponse(req: express.Request, res: express.Response) {
  if (isReviewConsentPagePath(req.path)) return reviewConsentPage(req, res);
  if (
    req.path.startsWith("/script") ||
    req.path.startsWith("/css") ||
    req.path.startsWith("/favicon") ||
    req.path.startsWith("/api")
  ) {
    return res.status(404).json({ error: "not_found" });
  }
  if (
    req.params.repoId &&
    req.headers["accept"] &&
    req.headers["accept"].indexOf("text/html") == -1
  ) {
    const repoId = req.path.split("/")[2];
    return res.redirect(
      `/api/repo/${repoId}/file/${req.path.substring(
        req.path.indexOf(repoId) + repoId.length + 1
      )}`
    );
  }
  res.type("html").send(getIndexHtml());
}

export default async function start() {
  const app = express();
  app.use(monitorRequests("api"));
  startPerformanceMonitoring("api", getAnonymizationPoolStats);
  app.set("query parser", "extended");
  app.use("/service", createReviewCapabilities(process.env.REVIEW_SERVICE_KEYS));
  app.use("/github/app/webhook", githubAppWebhook);
  app.use(express.json());
  // Preserve the empty body used by API validation when no JSON was parsed.
  app.use((req, _res, next) => {
    req.body ??= {};
    next();
  });

  app.use(
    compression({
      filter: (req, res) => {
        // Skip compression for streamed file content — these responses are
        // piped from the streamer and can be very large.  Compressing them
        // forces the middleware to hold per-response zlib buffers that pile
        // up under concurrent load and contribute to heap exhaustion.
        // Binary files (images, archives) barely compress anyway.
        if (req.path.match(/^\/api\/repo\/.+\/file\//)) return false;
        return compression.filter(req, res);
      },
    })
  );
  app.set("etag", "strong");
  // Trust the proxies declared in TRUST_PROXY (subnet list or legacy hop
  // count) so Express derives request.ip from the right X-Forwarded-For
  // entry. With the subnet form, Express skips every trusted address no
  // matter how many entries the proxies add, so request.ip stays the real
  // visitor even when Cloudflare changes how it builds the header. This is
  // what makes request.ip trustworthy for rate limiting instead of a
  // client-spoofable header.
  app.set("trust proxy", resolveTrustProxy(config.TRUST_PROXY));

  // handle session and connection
  app.use(initSession());
  app.use(passport.initialize());
  app.use(passport.session());
  app.use(bearerTokenAuth);

  startWorker();

  const redisClient = createClient({
    socket: {
      host: config.REDIS_HOSTNAME,
      port: config.REDIS_PORT,
    },
  });
  redisClient.on("error", (err) =>
    logger.error("redis client error", serializeError(err))
  );

  await redisClient.connect();

  const rate = rateLimit({
    store: new RedisStore({
      sendCommand: (...args: string[]) => redisClient.sendCommand(args),
    }),
    windowMs: 15 * 60 * 1000, // 15 minutes
    skip: async (request: express.Request, _response: express.Response) => {
      try {
        const user = await getUser(request);
        if (user && user.isAdmin) return true;
      } catch {
        // ignore: user not connected
      }
      return false;
    },
    limit: async (request: express.Request, _response: express.Response) => {
      try {
        const user = await getUser(request);
        if (user) return config.RATE_LIMIT;
      } catch {
        // ignore: user not connected
      }
      // if not logged in, limit to half the rate
      return config.RATE_LIMIT / 2;
    },
    keyGenerator: requestRateLimitKey,
    standardHeaders: "draft-6",
    legacyHeaders: false,
    handler: sendRequestRateLimit,
  });
  const speedLimiter = slowDown({
    windowMs: 15 * 60 * 1000, // 15 minutes
    delayAfter: 50,
    delayMs: () => 150,
    maxDelayMs: 5000,
    keyGenerator: requestRateLimitKey,
  });
  const webViewSpeedLimiter = slowDown({
    windowMs: 15 * 60 * 1000, // 15 minutes
    delayAfter: 200,
    delayMs: () => 150,
    maxDelayMs: 5000,
    keyGenerator: requestRateLimitKey,
  });

  app.use("/github", rate, speedLimiter, githubAppRouter);
  app.use("/github", rate, speedLimiter, connectionRouter);

  // api routes
  const apiRouter = express.Router();
  app.use("/api", rate, apiRouter);

  apiRouter.use("/admin", router.admin);
  apiRouter.use("/options", router.option);
  apiRouter.use("/conferences", router.conference);
  apiRouter.use("/user", router.user);
  apiRouter.use("/repo", router.repositoryPublic);
  apiRouter.use("/repo", speedLimiter, router.file);
  apiRouter.use("/repo", speedLimiter, router.repositoryPrivate);
  apiRouter.use("/pr", speedLimiter, router.pullRequestPublic);
  apiRouter.use("/pr", speedLimiter, router.pullRequestPrivate);
  apiRouter.use("/gist", speedLimiter, router.gistPublic);
  apiRouter.use("/gist", speedLimiter, router.gistPrivate);
  apiRouter.use("/anonymize-preview", speedLimiter, router.anonymizePreview);

  // Cache message.txt presence so /api/message doesn't hit the filesystem
  // synchronously on every request. Re-checked on a 60s interval — the file
  // is admin-managed and doesn't need real-time freshness.
  const messagePath = resolve("message.txt");
  let messageExists = existsSync(messagePath);
  setInterval(() => {
    messageExists = existsSync(messagePath);
  }, 60 * 1000).unref();
  apiRouter.get("/message", async (_, res) => {
    if (messageExists) {
      return res.sendFile(messagePath);
    }
    res.sendStatus(404);
  });

  apiRouter.get("/healthcheck", async (_, res) => {
    res.json({ status: "ok" });
  });
  apiRouter.get("/stat", async (_, res) => {
    res.json(await getCurrentStats());
  });
  apiRouter.get("/stat/history", async (req, res) => {
    res.json(await getStatsHistory(parseInt(String(req.query.days)) || 30));
  });

  // web view
  app.use("/w/", rate, webViewSpeedLimiter, router.webview);

  // Hashed assets (e.g. core.a1b2c3d4e5.min.js) — immutable, cache for 1 year.
  // Strip the hash from the filename and serve the underlying file.
  app.get(
    /^\/(script|css)\/(.+)\.([a-f0-9]{10})\.(min\.\w+|\w+)$/,
    (req, res, next) => {
      const dir = req.params[0];     // "script" or "css"
      const base = req.params[1];    // e.g. "core"
      const ext = req.params[3];     // e.g. "min.js"
      // Express decodes captures, so validate before resolving the filename.
      if (
        (dir !== "script" && dir !== "css") ||
        base.startsWith(".") ||
        /[/\\\0]/.test(base)
      ) {
        return res.status(404).end();
      }
      const assetRoot = resolve("public", dir);
      const filePath = resolve(assetRoot, `${base}.${ext}`);
      if (!filePath.startsWith(assetRoot + sep)) return res.status(404).end();
      if (!existsSync(filePath)) return next();
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      res.sendFile(filePath);
    }
  );

  app.use(
    express.static(join("public"), {
      etag: true,
      lastModified: true,
      maxAge: 86400000, // 1 day (fonts, images, partials)
      index: false, // don't serve index.html for "/" — indexResponse handles it
    })
  );

  app
    .get("/", indexResponse)
    .get("/404", indexResponse)
    .get("/anonymize", indexResponse)
    .get("/r/:repoId{/*path}", indexResponse)
    .get("/repository/:repoId{/*path}", indexResponse);

  app.get("/{*path}", indexResponse);

  // start schedules
  conferenceStatusCheck();
  repositoryStatusCheck();
  dailyStatsSnapshot();

  await connect();
  await startTemporaryStorageMaintenance();
  app.listen(config.PORT);
  logger.info("server started", { port: config.PORT });
  ensureTodaySnapshot().catch((err) =>
    logger.error("ensureTodaySnapshot failed", serializeError(err))
  );
  recoverStuckPreparing().catch((err) =>
    logger.error("recoverStuckPreparing failed", serializeError(err))
  );
  recoverStuckRemoving().catch((err) =>
    logger.error("recoverStuckRemoving failed", serializeError(err))
  );
  runRepositoryStatusCheck().catch((err) =>
    logger.error("initial repository status check failed", serializeError(err))
  );
}

start();
