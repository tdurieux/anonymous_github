const express = require("express");
const { Octokit } = require("@octokit/rest");

const connection = require("./connection");
const db = require("../utils/database");
const repoUtils = require("../utils/repository");

const router = express.Router();

// user needs to be connected for all user API
router.use(connection.ensureAuthenticated);

router.get("/logout", async (req, res) => {
  try {
    req.logout();
    res.redirect("/");
  } catch (error) {
    console.error(req.path, error);
    res.status(500).json({ error });
  }
});

router.get("/", async (req, res) => {
  try {
    const photo = req.user.profile.photos.length
      ? req.user.profile.photos[0].value
      : null;
    res.json({ username: req.user.profile.username, photo });
  } catch (error) {
    console.error(req.path, error);
    res.status(500).json({ error });
  }
});

router.get("/default", async (req, res) => {
  try {
    const d = await db
      .get("users")
      .findOne({ username: req.user.username }, { projection: { default: 1 } });
    res.json(d.default);
  } catch (error) {
    console.error(req.path, error);
    res.status(500).json({ error });
  }
});

router.post("/default", async (req, res) => {
  try {
    const d = req.body;
    await db
      .get("users")
      .updateOne({ username: req.user.username }, { $set: { default: d } });
    res.send("ok");
  } catch (error) {
    console.error(req.path, error);
    res.status(500).json({ error });
  }
});

router.get("/anonymized_repositories", async (req, res) => {
  try {
    const repos = await db
      .get("anonymized_repositories")
      .find(
        {
          owner: req.user.username,
        },
        { projection: { token: 0, files: 0, originalFiles: 0 } }
      )
      .toArray();
    for (let repo of repos) {
      if (repo.options.expirationDate) {
        repo.options.expirationDate = new Date(repo.options.expirationDate);
      }
      if (
        repo.options.expirationMode != "never" &&
        repo.options.expirationDate != null &&
        repo.options.expirationDate < new Date()
      ) {
        await repoUtils.updateStatus({ repoId: repo.repoId }, "expired");
        repo.status = "expired";
      }
    }
    res.json(repos);
  } catch (error) {
    console.error(req.path, error);
    res.status(500).json({ error });
  }
});

router.get("/all_repositories", async (req, res) => {
  try {
    const user = await db
      .get()
      .collection("users")
      .findOne(
        { username: req.user.username },
        { projection: { repositories: 1 } }
      );
    if (!user) {
      res.status(401).send({ error: "user_not_found" });
    }
    if (user.repositories && req.query.force !== "1") {
      return res.json(user.repositories);
    } else {
      const octokit = new Octokit({ auth: req.user.accessToken });
      const repositories = await octokit.paginate(
        octokit.repos.listForAuthenticatedUser,
        {
          visibility: "all",
          sort: "pushed",
          per_page: 100,
        }
      );
      try {
        await db
          .get()
          .collection("users")
          .updateOne(
            { username: req.user.profile.username },
            { $set: { repositories } }
          );
        res.json(repositories);
      } catch (error) {
        res.status(500).send(error);
      }
    }
  } catch (error) {
    console.error(req.path, error);
    res.status(500).json({ error });
  }
});

module.exports = router;
