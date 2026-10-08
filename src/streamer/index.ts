import { config as dotenv } from "dotenv";
dotenv();

import * as express from "express";
import * as compression from "compression";

import config from "../config";
import router from "./route";
import { handleError } from "../server/routes/route-utils";
import AnonymousError from "../core/AnonymousError";
import { createLogger, serializeError } from "../core/logger";
import { connect } from "../server/database";
import { startTemporaryStorageMaintenance } from "../core/temporary-storage";
import { monitorRequests } from "../core/request-monitoring";
import { startPerformanceMonitoring } from "../core/performance-monitoring";
import { getAnonymizationPoolStats } from "../core/anonymization-pool";

const logger = createLogger("streamer");

const app = express();
app.use(monitorRequests("streamer"));
app.use(express.json());

app.use(
  compression({
    filter: (req, res) => {
      // The streamer serves file blobs that are often binary (images,
      // archives) and can be very large.  Compressing them holds zlib
      // buffers per response that pile up under concurrent load.
      if (req.path === "/api" && req.method === "POST") return false;
      return compression.filter(req, res);
    },
  })
);

app.use("/api", router);

app.get("/healthcheck", async (_, res) => {
  res.json({ status: "ok" });
});

app.all("/{*path}", (req, res) => {
  handleError(
    new AnonymousError("file_not_found", {
      httpStatus: 404,
      url: req.originalUrl,
    }),
    res,
    req
  );
});
async function start() {
  startPerformanceMonitoring("streamer", getAnonymizationPoolStats);
  await connect({ appName: "Anonymous GitHub Streamer", maxPoolSize: 10, minPoolSize: 0 });
  await startTemporaryStorageMaintenance();
  app.listen(config.PORT, (error?: Error) => {
    if (error) throw error;
    logger.info("streamer started", { port: config.PORT });
  });
}
void start().catch(error => {
  logger.error("streamer startup failed", serializeError(error));
  process.exit(1);
});
