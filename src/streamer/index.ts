import { config as dotenv } from "dotenv";
dotenv();

import * as express from "express";
import * as compression from "compression";

import config from "../config";
import router from "./route";
import { handleError } from "../server/routes/route-utils";
import AnonymousError from "../core/AnonymousError";

const app = express();
app.use(express.json());

app.use(compression());

app.use("/api", router);

app.get("/healthcheck", async (_, res) => {
  res.json({ status: "ok" });
});

app.all("*", (req, res) => {
  handleError(
    new AnonymousError("file_not_found", {
      httpStatus: 404,
      object: req.originalUrl,
    }),
    res,
    req
  );
});
app.listen(config.PORT, () => {
  console.log(`Server started on http://streamer:${config.PORT}`);
});
