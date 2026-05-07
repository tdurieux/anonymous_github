import { config as dotenv } from "dotenv";
dotenv();

import * as express from "express";
import * as compression from "compression";

import config from "../config";
import router from "./route";
import { handleError } from "../server/routes/route-utils";
import AnonymousError from "../core/AnonymousError";
import { createLogger } from "../core/logger";

const logger = createLogger("streamer");

const app = express();
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

app.all("*", (req, res) => {
  handleError(
    new AnonymousError("file_not_found", {
      httpStatus: 404,
      url: req.originalUrl,
    }),
    res,
    req
  );
});
app.listen(config.PORT, () => {
  logger.info("streamer started", { port: config.PORT });
});
