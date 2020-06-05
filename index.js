const ofs = require("fs");
const fs = require("fs").promises;
const path = require("path");
const downloadGit = require("download-git-repo");
const { Octokit } = require("@octokit/rest");
const loc = require("@umijs/linguist");
const gh = require("parse-github-url");

const passport = require("passport");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const GitHubStrategy = require("passport-github2").Strategy;

const express = require("express");
const compression = require("compression");
const bodyParser = require("body-parser");

const config = require("./config");

const app = express();
app.use(bodyParser.json());
app.use(compression());

passport.serializeUser(function (user, done) {
  done(null, user);
});

passport.deserializeUser(function (obj, done) {
  done(null, obj);
});

passport.use(
  new GitHubStrategy(
    {
      clientID: config.clientId,
      clientSecret: config.clientSecret,
      callbackURL: config.authCallback,
    },
    (accessToken, refreshToken, profile, done) => {
      // asynchronous verification, for effect...
      console.log({ accessToken, refreshToken, profile });
      done(null, { accessToken, refreshToken, profile });

      // an example of how you might save a user
      // new User({ username: profile.username }).fetch().then(user => {
      //   if (!user) {
      //     user = User.forge({ username: profile.username })
      //   }
      //
      //   user.save({ profile: profile, access_token: accessToken }).then(() => {
      //     return done(null, user)
      //   })
      // })
    }
  )
);
app.use(
  session({
    secret: "keyboard cat",
    resave: true,
    saveUninitialized: true,
    store: new FileStore({
      path: "./session-store",
    }),
  })
);
app.use(passport.initialize());
app.use(passport.session());

app.get(
  "/github/login",
  passport.authenticate("github", { scope: ["repo"] }), /// Note the scope here
  function (req, res) {
    console.log("/github/login");
  }
);

app.get(
  "/github/auth",
  passport.authenticate("github", { failureRedirect: "/" }),
  function (req, res) {
    console.log("here");
    res.redirect("/");
  }
);

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect("/github/login");
}

app.get("/api/user", async (req, res) => {
  if (req.user) {
    res.json({ username: req.user.profile.username });
  } else {
    res.status(403).json({ error: "not_connected" });
  }
});

app.get("/api/repos", ensureAuthenticated, async (req, res) => {
  const octokit = new Octokit({ auth: req.user.accessToken });
  const repos = await octokit.repos.listForAuthenticatedUser({
    visibility: "all",
    sort: "pushed",
    per_page: 100,
  });
  res.json(repos);
});

app.get("/([r|repository])/:id/commit/:sha", (req, res) => {
  res.status(500).send("To implement!");
});

function downloadRepoAndAnonymize(repoConfig) {
  const cachePath = path.resolve(
    __dirname,
    "repositories",
    repoConfig.id,
    "cache"
  );

  return new Promise(async (resolve, reject) => {
    fs.access(cachePath, ofs.constants.F_OK).then(
      () => {},
      (_) => {
        try {
          const opt = {
            filter: (file) => {
              return true;
            },
            map: (file) => {
              if (file.path.indexOf(".md") > -1) {
                let content = file.data.toString();
                for (let term of repoConfig.terms) {
                  content = content.replace(new RegExp(term, "gi"), "XXX");
                }
                file.data = content;

                let path = file.path;
                for (let term of repoConfig.terms) {
                  path = path.replace(new RegExp(term, "gi"), "XXX");
                }
                file.path = path;
              }
              return file;
            },
          };
          const gurl = gh(repoConfig.repository);
          if (repoConfig.token) {
            opt.headers = {
              "Authorization": `token ${repoConfig.token}`,
              "user-agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.138 Safari/537.36",
              "accept": "application/vnd.github.3.raw",
            };
            opt.clone = false;
          }
          const url = `direct:https://api.github.com/repos/${gurl.repo}/tarball`;
          downloadGit(url, cachePath, opt, (err) => {
            console.log(err);
            resolve();
          });
        } catch (error) {
          console.log(error);
          resolve();
        }
      }
    );
  });
}

async function walk(dir, root) {
  if (root == null) {
    root = dir;
  }
  let files = await fs.readdir(dir);
  const output = {};
  for (let file of files) {
    let filePath = path.join(dir, file);
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      output[file] = await walk(filePath, root);
    } else if (stats.isFile()) {
      output[file] = stats.size;
    }
  }
  return output;
}

app.get("/api/files/:id/", (req, res) => {
  const repo_id = req.params.id;
  if (!repo_id) {
    return res.status(404).json({ error: "invalid_repo_id" });
  }
  const repoPath = path.resolve(__dirname, "repositories", repo_id);
  fs.access(repoPath, ofs.constants.F_OK).then(
    (_) => {
      fs.readFile(path.resolve(repoPath, "config.json")).then(
        async (data) => {
          data = JSON.parse(data);
          const repoCache = path.join(repoPath, "cache");
          if (!ofs.existsSync(repoCache)) {
            await downloadRepoAndAnonymize(data, repo_id);
          }
          fs.access(repoCache, ofs.constants.F_OK).then(
            async (_) => {
              res.json(await walk(repoCache));
            },
            (_) => res.status(404).json({ error: "repo_not_found" })
          );
        },
        (_) => res.status(404).json({ error: "config_error" })
      );
    },
    (_) => res.status(404).json({ error: "repo_not_found" })
  );
});
app.get("/api/repository/:id/:path*", (req, res) => {
  const repo_id = req.params.id;
  console.log(repo_id);
  if (!repo_id) {
    return res.status(404).json({ error: "invalid_repo_id" });
  }
  const repoPath = path.resolve(__dirname, "repositories", repo_id);
  const repoConfig = path.join(repoPath, "config.json");
  const repoCache = path.join(repoPath, "cache");
  fs.access(repoConfig, ofs.constants.F_OK).then(
    (_) => {
      fs.readFile(repoConfig).then(
        async (data) => {
          data = JSON.parse(data);
          if (!ofs.existsSync(repoCache)) {
            await downloadRepoAndAnonymize(data, repo_id);
          }
          let requestPath = req.params.path;
          if (req.params[0]) {
            requestPath += req.params[0];
          }
          if (requestPath == null) {
            requestPath = "README.md";
          }

          const ppath = path.join(repoCache, requestPath);
          fs.access(ppath, ofs.constants.F_OK).then(
            (ok) => res.sendFile(ppath, { dotfiles: "allow" }),
            (ko) =>
              res
                .status(404)
                .json({ error: "file_not_found", path: requestPath })
          );
        },
        (_) => res.status(404).json({ error: "config_error" })
      );
    },
    (_) => res.status(404).json({ error: "repo_not_found" })
  );
});

app.get("/api/stat/:id/", (req, res) => {
  const repo_id = req.params.id;
  const repoPath = path.resolve(__dirname, "repositories", repo_id);
  const repoCache = path.join(repoPath, "cache");
  if (ofs.existsSync(repoCache)) {
    res.json(loc(repoCache).languages);
  } else {
    res.status(404).json({ error: "repo_not_found" });
  }
});
app.post("/", (req, res) => {
  res.status(500).send("To implement!");
});

app.use(express.static(__dirname + "/public"));

function homeAppResponse(req, res) {
  res.sendFile(path.resolve(__dirname, "public", "index.html"));
}
function exploreAppResponse(req, res) {
  res.sendFile(path.resolve(__dirname, "public", "explore.html"));
}
app
  .get("/", homeAppResponse)
  .get("/myrepo", homeAppResponse)
  .get("/r/*", exploreAppResponse)
  .get("/repository/*", exploreAppResponse);

app.listen(5000, () => {});
