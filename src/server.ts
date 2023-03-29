import { createClient } from "redis";
import { resolve, join } from "path";
import { existsSync } from "fs";
import rateLimit from "express-rate-limit";
import * as slowDown from "express-slow-down";
import RedisStore from "rate-limit-redis";
import * as express from "express";
import * as compression from "compression";
import * as passport from "passport";

import config from "../config";
import { connect } from "./database/database";
import { initSession, router as connectionRouter } from "./routes/connection";
import router from "./routes";
import AnonymizedRepositoryModel from "./database/anonymizedRepositories/anonymizedRepositories.model";
import { conferenceStatusCheck, repositoryStatusCheck } from "./schedule";
import { startWorker } from "./queue";
import AnonymizedPullRequestModel from "./database/anonymizedPullRequests/anonymizedPullRequests.model";

function indexResponse(req: express.Request, res: express.Response) {
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
  app.set("trust proxy", true);
  app.set("etag", "strong");

  app.get("/ip", (request, response) => response.send(request.ip));

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

  const rate = rateLimit({
    store: new RedisStore({
      sendCommand: (...args: string[]) => redisClient.sendCommand(args),
    }),
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: config.RATE_LIMIT, // limit each IP
    standardHeaders: true,
    legacyHeaders: false,
  });
  const speedLimiter = slowDown({
    windowMs: 15 * 60 * 1000, // 15 minutes
    delayAfter: 50,
    delayMs: 150,
    maxDelayMs: 5000,
    headers: true,
  });
  const webViewSpeedLimiter = slowDown({
    windowMs: 15 * 60 * 1000, // 15 minutes
    delayAfter: 200,
    delayMs: 150,
    maxDelayMs: 5000,
    headers: true,
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

  apiRouter.get("/stat", async (_, res) => {
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

    res.json({
      nbRepositories,
      nbUsers: users.length,
      nbPageViews: nbPageViews[0]?.total || 0,
      nbPullRequests,
    });
  });

  // web view
  app.use("/w/", rate, webViewSpeedLimiter, router.webview);

  app
    .get("/", indexResponse)
    .get("/404", indexResponse)
    .get("/anonymize", indexResponse)
    .get("/r/:repoId/?*", indexResponse)
    .get("/repository/:repoId/?*", indexResponse);

  app.use(
    express.static(join("public"), {
      etag: true,
      lastModified: true,
      maxAge: 3600, // 1h
    })
  );

  app.get("*", indexResponse);

  // start schedules
  conferenceStatusCheck();
  repositoryStatusCheck();

  await connect();
  app.listen(config.PORT);
  console.log("Database connected and Server started on port: " + config.PORT);
}
