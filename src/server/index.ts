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
import router from "./routes";
import AnonymizedRepositoryModel from "../core/model/anonymizedRepositories/anonymizedRepositories.model";
import { conferenceStatusCheck, repositoryStatusCheck } from "./schedule";
import { startWorker } from "../queue";
import AnonymizedPullRequestModel from "../core/model/anonymizedPullRequests/anonymizedPullRequests.model";
import { getUser } from "./routes/route-utils";
import config from "../config";

function indexResponse(req: express.Request, res: express.Response) {
  if (
    req.path.startsWith("/script") ||
    req.path.startsWith("/css") ||
    req.path.startsWith("/favicon") ||
    req.path.startsWith("/api")
  ) {
    return res.status(404).send("Not found");
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

  startWorker();

  const redisClient = createClient({
    socket: {
      host: config.REDIS_HOSTNAME,
      port: config.REDIS_PORT,
    },
  });
  redisClient.on("error", (err) => console.log("Redis Client Error", err));

  await redisClient.connect();

  function keyGenerator(
    request: express.Request,
    _response: express.Response
  ): string {
    if (request.headers["cf-connecting-ip"]) {
      return request.headers["cf-connecting-ip"] as string;
    }
    if (!request.ip && request.socket.remoteAddress) {
      console.error("Warning: request.ip is missing!");
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
    skip: async (request: express.Request, response: express.Response) => {
      try {
        const user = await getUser(request);
        if (user && user.isAdmin) return true;
      } catch (_) {
        // ignore: user not connected
      }
      return false;
    },
    max: async (request: express.Request, response: express.Response) => {
      try {
        const user = await getUser(request);
        if (user) return config.RATE_LIMIT;
      } catch (_) {
        // ignore: user not connected
      }
      // if not logged in, limit to half the rate
      return config.RATE_LIMIT / 2;
    },
    keyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    message: (request: express.Request, response: express.Response) => {
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
      console.log(
        `${req.method} ${res.statusCode} ${join(
          req.baseUrl || "",
          req.url || ""
        )} ${time}ms`
      );
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

  apiRouter.get("/message", async (_, res) => {
    if (existsSync("./message.txt")) {
      return res.sendFile(resolve("message.txt"));
    }
    res.sendStatus(404);
  });

  let stat: any = {};

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
    const [nbRepositories, users, nbPageViews, nbPullRequests] =
      await Promise.all([
        AnonymizedRepositoryModel.estimatedDocumentCount(),
        AnonymizedRepositoryModel.distinct("owner"),
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
      nbUsers: users.length,
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
  app.listen(config.PORT);
  console.log("Database connected and Server started on port: " + config.PORT);
}

start();
