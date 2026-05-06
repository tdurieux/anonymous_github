import { config as dotenv } from "dotenv";
dotenv();

import { createClient } from "redis";
import { resolve, join } from "path";
import { existsSync } from "fs";
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
import AnonymizedRepositoryModel from "../core/model/anonymizedRepositories/anonymizedRepositories.model";
import { conferenceStatusCheck, repositoryStatusCheck } from "./schedule";
import { startWorker, recoverStuckPreparing } from "../queue";
import AnonymizedPullRequestModel from "../core/model/anonymizedPullRequests/anonymizedPullRequests.model";
import { getUser } from "./routes/route-utils";
import config from "../config";
import { createLogger, serializeError } from "../core/logger";

const logger = createLogger("server");

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
    // if it is not an html request, it assumes that the browser try to load a different type of resource
    return res.redirect(
      `/api/repo/${repoId}/file/${req.path.substring(
        req.path.indexOf(repoId) + repoId.length + 1
      )}`
    );
  }
  res.sendFile(resolve("public", "index.html"));
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

  setInterval(() => {
    stat = {};
  }, 1000 * 60 * 60);

  apiRouter.get("/healthcheck", async (_, res) => {
    res.json({ status: "ok" });
  });
  apiRouter.get("/stat", async (_, res) => {
    if (stat.nbRepositories) {
      res.json(stat);
      return;
    }
    const [nbRepositories, nbUsersAgg, nbPageViews, nbPullRequests] =
      await Promise.all([
        AnonymizedRepositoryModel.estimatedDocumentCount(),
        // Count distinct owners server-side instead of materializing the full
        // list of ObjectIds with `.distinct("owner")` only to take its length.
        AnonymizedRepositoryModel.collection
          .aggregate([
            { $group: { _id: "$owner" } },
            { $count: "n" },
          ])
          .toArray(),
        AnonymizedRepositoryModel.collection
          .aggregate([
            {
              $group: { _id: null, total: { $sum: "$pageView" } },
            },
          ])
          .toArray(),
        AnonymizedPullRequestModel.estimatedDocumentCount(),
      ]);

    stat = {
      nbRepositories,
      nbUsers: (nbUsersAgg[0] as { n?: number } | undefined)?.n || 0,
      nbPageViews: nbPageViews[0]?.total || 0,
      nbPullRequests,
    };

    res.json(stat);
  });

  // web view
  app.use("/w/", rate, webViewSpeedLimiter, router.webview);

  app.use(
    express.static(join("public"), {
      etag: true,
      lastModified: true,
      maxAge: 3600, // 1h
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

  await connect();
  await recoverStuckPreparing();
  app.listen(config.PORT);
  logger.info("server started", { port: config.PORT });
}

start();
