import { config as dotenv } from "dotenv";
dotenv();

import { createClient } from "redis";
import { resolve, join } from "path";
import { existsSync, readFileSync } from "fs";
import rateLimit from "express-rate-limit";
import { slowDown } from "express-slow-down";
import RedisStore from "rate-limit-redis";
import * as express from "express";
import * as compression from "compression";
import * as passport from "passport";
import { connect } from "./database";
import { initSession, router as connectionRouter } from "./routes/connection";
import { bearerTokenAuth } from "./routes/token-auth";
import router from "./routes";
import {
  conferenceStatusCheck,
  repositoryStatusCheck,
  dailyStatsSnapshot,
} from "./schedule";
import { startWorker, recoverStuckPreparing } from "../queue";
import {
  computeStats,
  ensureTodaySnapshot,
} from "./dailyStatsSnapshot";
import DailyStatsModel from "../core/model/dailyStats/dailyStats.model";
import { getUser } from "./routes/route-utils";
import config from "../config";
import { createLogger, serializeError } from "../core/logger";

const logger = createLogger("server");

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
  app.use(express.json());

  app.use(compression());
  app.set("etag", "strong");

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

  function keyGenerator(
    request: express.Request,
    _response: express.Response
  ): string {
    if (request.headers["cf-connecting-ip"]) {
      return request.headers["cf-connecting-ip"] as string;
    }
    if (!request.ip && request.socket.remoteAddress) {
      logger.warn("request.ip is missing");
      return request.socket.remoteAddress;
    }
    // remove port number from IPv4 addresses
    return (request.ip || "").replace(/:\d+[^:]*$/, "");
  }

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
    max: async (request: express.Request, _response: express.Response) => {
      try {
        const user = await getUser(request);
        if (user) return config.RATE_LIMIT;
      } catch {
        // ignore: user not connected
      }
      // if not logged in, limit to half the rate
      return config.RATE_LIMIT / 2;
    },
    keyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    message: (_request: express.Request, _response: express.Response) => {
      return `You can only make ${config.RATE_LIMIT} requests every 15min. Please try again later.`;
    },
  });
  const speedLimiter = slowDown({
    windowMs: 15 * 60 * 1000, // 15 minutes
    delayAfter: 50,
    delayMs: () => 150,
    maxDelayMs: 5000,
    keyGenerator,
  });
  const webViewSpeedLimiter = slowDown({
    windowMs: 15 * 60 * 1000, // 15 minutes
    delayAfter: 200,
    delayMs: () => 150,
    maxDelayMs: 5000,
    keyGenerator,
  });

  app.use(function (req, res, next) {
    const start = Date.now();
    res.on("finish", function () {
      const time = Date.now() - start;
      logger.info("request", {
        method: req.method,
        status: res.statusCode,
        url: join(req.baseUrl || "", req.url || ""),
        ms: time,
      });
    });
    next();
  });

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

  let stat: Record<string, unknown> = {};
  let history: Array<Record<string, unknown>> | null = null;
  let historyKey: number | null = null;

  setInterval(() => {
    stat = {};
    history = null;
    historyKey = null;
  }, 1000 * 60 * 60);

  apiRouter.get("/healthcheck", async (_, res) => {
    res.json({ status: "ok" });
  });
  apiRouter.get("/stat", async (_, res) => {
    if (stat.nbRepositories) {
      res.json(stat);
      return;
    }
    stat = { ...(await computeStats()) };
    res.json(stat);
  });

  apiRouter.get("/stat/history", async (req, res) => {
    const days = Math.min(
      Math.max(parseInt(req.query.days as string) || 30, 1),
      365
    );
    if (history && historyKey === days) {
      res.json(history);
      return;
    }
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days + 1);
    since.setUTCHours(0, 0, 0, 0);
    const docs = await DailyStatsModel.find({ date: { $gte: since } })
      .sort({ date: 1 })
      .lean();
    history = docs.map((d) => ({
      date: d.date,
      nbRepositories: d.nbRepositories,
      nbUsers: d.nbUsers,
      nbPageViews: d.nbPageViews,
      nbPullRequests: d.nbPullRequests,
    }));
    historyKey = days;
    res.json(history);
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
      const filePath = join("public", dir, `${base}.${ext}`);
      if (!existsSync(filePath)) return next();
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      res.sendFile(resolve(filePath));
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
    .get("/r/:repoId/?*", indexResponse)
    .get("/repository/:repoId/?*", indexResponse);

  app.get("*", indexResponse);

  // start schedules
  conferenceStatusCheck();
  repositoryStatusCheck();
  dailyStatsSnapshot();

  await connect();
  app.listen(config.PORT);
  logger.info("server started", { port: config.PORT });
  ensureTodaySnapshot().catch((err) =>
    logger.error("ensureTodaySnapshot failed", serializeError(err))
  );
  recoverStuckPreparing().catch((err) =>
    logger.error("recoverStuckPreparing failed", serializeError(err))
  );
}

start();
