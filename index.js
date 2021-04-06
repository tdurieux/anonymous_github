const path = require("path");
const ofs = require("fs");
const fs = require("fs").promises;
const redis = require("redis");
const RateLimit = require("express-rate-limit");
const RedisStore = require("rate-limit-redis");
const express = require("express");
const compression = require("compression");
const bodyParser = require("body-parser");

const rediscli = redis.createClient({
  host: "redis",
  ttl: 260,
});

const connection = require("./routes/connection");

const db = require("./utils/database");
const fileUtils = require("./utils/file");

const PORT = process.env.PORT || 5000;

const app = express();
app.use(bodyParser.json());
app.use(compression());
app.set("trust proxy", 1);

// handle session and connection
app.use(connection.session);
app.use(connection.passport.initialize());
app.use(connection.passport.session());

const rateLimit = new RateLimit({
  store: new RedisStore({
    client: rediscli,
  }),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // limit each IP to 100 requests per windowMs
  // delayMs: 0, // disable delaying - full speed until the max limit is reached
});

app.use("/github", rateLimit, connection.router);

// app routes
app.use("/api/user", rateLimit, require("./routes/user"));
app.use("/api/repo", rateLimit, require("./routes/file"));
app.use("/api/repo", rateLimit, require("./routes/repository"));

// wesite view
app.use("/w/", rateLimit, require("./routes/webview"));

app.use(express.static(__dirname + "/public"));

async function homeAppResponse(_, res) {
  res.sendFile(path.resolve(__dirname, "public", "index.html"));
}
function exploreAppResponse(req, res) {
  if (req.headers["accept"].indexOf("text/html") == -1) {
    // if it is not an html request, it assumes that the browser try to load a different type of resource
    return res.redirect(`/api/repo/${req.params.repoId}/file/${req.params[0]}`);
  }
  res.sendFile(path.resolve(__dirname, "public", "explore.html"));
}

app.get("/api/supportedTypes", async (_, res) => {
  res.json(
    require("textextensions")
      .default.concat(fileUtils.additionalExtensions)
      .sort()
  );
});

app.get("/api/message", async (_, res) => {
  if (ofs.existsSync("./message.txt")) {
    return res.sendFile(path.resolve(__dirname, "message.txt"));
  }
  res.sendStatus(404);
});

app.get("/api/stat", async (_, res) => {
  const nbRepositories = await db
    .get("anonymized_repositories")
    .estimatedDocumentCount();

  const nbUsers = (await db.get("anonymized_repositories").distinct("owner"))
    .length; //await db.get("users").estimatedDocumentCount();
  res.json({ nbRepositories, nbUsers });
});

app
  .get("/", homeAppResponse)
  .get("/404", homeAppResponse)
  .get("/anonymize", homeAppResponse)
  .get("/r/:repoId/?*", exploreAppResponse)
  .get("/repository/:repoId/?*", exploreAppResponse)
  .get("*", homeAppResponse);

db.connect().then((_) => {
  app.listen(PORT, () => {
    console.log("Database connected and Server started on port: " + PORT);
  });
});
