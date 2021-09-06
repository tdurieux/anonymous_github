import * as path from "path";
import * as ofs from "fs";
import * as redis from "redis";
import * as rateLimit from "express-rate-limit";
import * as RedisStore from "rate-limit-redis";
import * as express from "express";
import * as compression from "compression";
import * as db from "./database/database";
import config from "../config";
import * as passport from "passport";

import * as connection from "./routes/connection";
import router from "./routes";
import AnonymizedRepositoryModel from "./database/anonymizedRepositories/anonymizedRepositories.model";
import { conferenceStatusCheck } from "./schedule";

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
  res.sendFile(path.resolve(__dirname, "..", "public", "index.html"));
}

export default async function start() {
  const app = express();
  app.use(express.json());

  app.use(compression());
  app.set("trust proxy", 1);

  // handle session and connection
  app.use(connection.appSession);
  app.use(passport.initialize());
  app.use(passport.session());

  const rate = rateLimit({
    store: new RedisStore({
      client: redis.createClient({
        host: config.REDIS_HOSTNAME,
        port: config.REDIS_PORT,
      }),
    }),
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // limit each IP
    // delayMs: 0, // disable delaying - full speed until the max limit is reached
  });

  app.use("/github", rate, connection.router);

  // api routes
  app.use("/api/options", rate, router.option);
  app.use("/api/conferences", rate, router.conference);
  app.use("/api/user", rate, router.user);
  app.use("/api/repo", rate, router.repositoryPublic);
  app.use("/api/repo", rate, router.file);
  app.use("/api/repo", rate, router.repositoryPrivate);
  app.use("/w/", rate, router.webview);

  app.get("/api/message", async (_, res) => {
    if (ofs.existsSync("./message.txt")) {
      return res.sendFile(path.resolve(__dirname, "..", "message.txt"));
    }
    res.sendStatus(404);
  });

  app.get("/api/stat", async (_, res) => {
    const nbRepositories =
      await AnonymizedRepositoryModel.estimatedDocumentCount();

    const nbUsers = (await AnonymizedRepositoryModel.distinct("owner")).length;
    res.json({ nbRepositories, nbUsers });
  });

  app
    .get("/", indexResponse)
    .get("/404", indexResponse)
    .get("/anonymize", indexResponse)
    .get("/r/:repoId/?*", indexResponse)
    .get("/repository/:repoId/?*", indexResponse);

  app.use(
    express.static(path.join(__dirname, "..", "public"), {
      etag: true,
      lastModified: true,
      maxAge: 3600000, // 1h
    })
  );

  app.get("*", indexResponse);

  // start schedules
  conferenceStatusCheck();

  await db.connect();
  app.listen(config.PORT);
  console.log("Database connected and Server started on port: " + config.PORT);
}
