const ofs = require("fs");
const fs = require("fs").promises;

const express = require("express");
const gh = require("parse-github-url");
const arrayEquals = require("array-equal");

const connection = require("./connection");
const githubUtils = require("../utils/github");
const db = require("../utils/database");
const repoUtils = require("../utils/repository");
const config = require("../config");

const router = express.Router();

// user needs to be connected for all user API
router.use(connection.ensureAuthenticated);

// claim a repository
router.post("/claim", async (req, res) => {
  try {
    if (!req.body.repoId) {
      return res.status(500).json({ error: "repoId_not_defined" });
    }
    if (!req.body.repoUrl) {
      return res.status(500).json({ error: "repoUrl_not_defined" });
    }
    
    const repoConfig = await repoUtils.getConfig(req.body.repoId);
    if (repoConfig == null) {
      return res.status(500).json({ error: "repo_not_found" });
    }

    const repo = gh(req.body.repoUrl);
    if (repoConfig.fullName != repo.repository) {
      return res.status(500).json({ error: "repo_not_found" });
    }

    console.log(`${req.user.username} claims ${repoConfig.fullName}.`);

    await db
      .get("anonymized_repositories")
      .updateOne(
        { repoId: repoConfig.repoId },
        { $set: { owner: req.user.username } }
      );
    return res.send("Ok");
  } catch (error) {
    console.error(req.path, error);
    return res.status(500).json({ error });
  }
});

router.get("/:repoId/", async (req, res) => {
  try {
    const repository = await repoUtils.getAnonymizedRepoDetails(
      req.params.repoId,
      req.user
    );
    if (repository) {
      return res.json(repository);
    }
    res.status(404).send("repo_not_found");
  } catch (error) {
    console.error(req.path, error);
    res.status(500).send(error);
  }
});

// update a repository
router.post("/:repoId/", async (req, res) => {
  const repoUpdate = req.body;

  let repoConfig = await repoUtils.getConfig(req.params.repoId);
  if (repoConfig == null) {
    return res.status(500).json({ error: "repo_not_found" });
  }
  if (repoConfig.owner != req.user.username) {
    return res.status(401).json({ error: "not_authorized" });
  }
  if (!repoUpdate.branch) {
    return res.status(500).json({ error: "branch_not_specified" });
  }
  if (!repoUpdate.options) {
    return res.status(500).json({ error: "options_not_provided" });
  }
  if (!Array.isArray(repoUpdate.terms)) {
    return res.status(500).send({ error: "invalid_terms_format" });
  }
  if (!/^[a-f0-9]+$/.test(repoUpdate.commit)) {
    return res.status(500).send({ error: "invalid_commit_format" });
  }

  try {
    const details = await repoUtils.getRepoDetails({
      repoConfig,
      force: true,
      token: req.user.accessToken,
    });
    if (repoUpdate.options.mode == "download") {
      // details.size is in kilobytes
      if (details.size > config.MAX_REPO_SIZE) {
        return res.status(500).send({ error: "invalid_mode" });
      }
    }

    if (repoUpdate.commit != repoConfig.commit) {
      repoUpdate.anonymizeDate = new Date();
      await repoUtils.removeRepository(repoConfig);
    }
    if (
      !arrayEquals(repoUpdate.terms, repoConfig.terms) ||
      repoUpdate.options.link != repoConfig.options.link ||
      repoUpdate.options.image != repoConfig.options.image
    ) {
      repoUpdate.anonymizeDate = new Date();
      if (ofs.existsSync(repoUtils.getAnonymizedPath(repoConfig.repoId))) {
        await fs.rm(repoUtils.getAnonymizedPath(repoConfig.repoId), {
          recursive: true,
          force: true,
        });
      }
    }
    const data = {
      terms: repoUpdate.terms,
      branch: repoUpdate.branch,
      commit: repoUpdate.commit,
      options: {
        expirationMode: repoUpdate.options.expirationMode,
        expirationDate: repoUpdate.options.expirationDate,
        update: repoUpdate.options.update,
        image: repoUpdate.options.image,
        pdf: repoUpdate.options.pdf,
        notebook: repoUpdate.options.notebook,
        loc: repoUpdate.options.loc,
        link: repoUpdate.options.link,
        mode: repoUpdate.options.mode,
        page: repoUpdate.options.page,
      },
    };
    if (repoUpdate.options.page) {
      data.options.pageSource = details.pageSource;
    }
    await db.get("anonymized_repositories").updateOne(
      {
        repoId: repoConfig.repoId,
      },
      {
        $set: data,
      }
    );

    repoConfig = await repoUtils.getConfig(repoUpdate.repoId);
    await repoUtils.updateStatus(repoConfig, "preparing");

    res.send("ok");
  } catch (error) {
    console.error(req.path, error);
    await repoUtils.updateStatus(repoConfig, "error", error);
    return res.status(500).json({ error });
  }
  try {
    await githubUtils.downloadRepoAndAnonymize(repoConfig);
    await repoUtils.updateStatus(repoConfig, "ready");
  } catch (error) {
    console.error(req.path, error);
    await repoUtils.updateStatus(repoConfig, "error", error);
  }
});

// refresh a repository
router.post("/:repoId/refresh", async (req, res) => {
  try {
    const repoConfig = await repoUtils.getConfig(req.params.repoId);
    if (repoConfig == null) {
      return res.status(500).json({ error: "repo_not_found" });
    }
    if (repoConfig.owner != req.user.username) {
      return res.status(401).json({ error: "not_authorized" });
    }

    await repoUtils.updateAnonymizedRepository(repoConfig);
    return res.send("ok");
  } catch (error) {
    console.error(req.path, error);
    return res.status(500).json({ error });
  }
});

// delete a repository
router.delete("/:repoId/", async (req, res) => {
  try {
    const repoConfig = await repoUtils.getConfig(req.params.repoId);
    if (repoConfig == null) {
      return res.status(500).json({ error: "repo_not_found" });
    }
    if (repoConfig.owner != req.user.username) {
      return res.status(401).json({ error: "not_authorized" });
    }

    await repoUtils.updateStatus(repoConfig, "removed");
    await repoUtils.removeRepository(repoConfig);
    console.log(`${req.params.repoId} is removed`);
    return res.json("ok");
  } catch (error) {
    console.error(req.path, error);
    return res.status(500).json({ error });
  }
});

router.get("/:owner/:repo/", async (req, res) => {
  try {
    const repository = await repoUtils.getRepoDetails({
      owner: req.params.owner,
      repo: req.params.repo,
      token: req.user.accessToken,
      force: req.query.force === "1",
    });
    if (repository) {
      return res.json(repository);
    }
    res.status(404).send("repo_not_found");
  } catch (error) {
    console.error(req.path, error);
    res.status(500).send(error);
  }
});

router.get("/:owner/:repo/branches", async (req, res) => {
  try {
    const repository = await repoUtils.getRepoBranches({
      owner: req.params.owner,
      repo: req.params.repo,
      token: req.user.accessToken,
      force: req.query.force === "1",
    });
    if (repository) {
      return res.json(repository);
    }
    res.status(404).send("repo_not_found");
  } catch (error) {
    console.error(req.path, error);
    res.status(500).send(error);
  }
});

router.get("/:owner/:repo/readme", async (req, res) => {
  try {
    const readme = await repoUtils.getRepoReadme({
      owner: req.params.owner,
      repo: req.params.repo,
      token: req.user.accessToken,
      force: req.query.force === "1",
    });
    if (readme) {
      return res.send(readme);
    }
    res.status(404).send("repo_not_found");
  } catch (error) {
    res.status(500).send(error);
  }
});

router.post("/", async (req, res) => {
  const repoConfig = req.body;

  try {
    const repository = await repoUtils.getConfig(repoConfig.repoId);
    const cacheExist = ofs.existsSync(
      repoUtils.getOriginalPath(repoConfig.repoId)
    );
    if (repository && cacheExist) {
      return res.status(500).send({ error: "repoId_already_used" });
    }
    var validCharacters = /^[0-9a-zA-Z\-\_]+$/;
    if (
      !repoConfig.repoId.match(validCharacters) ||
      repoConfig.repoId.length < 3
    ) {
      return res.status(500).send({ error: "invalid_repoId" });
    }
    if (!repoConfig.branch) {
      return res.status(500).json({ error: "branch_not_specified" });
    }
    if (!repoConfig.options) {
      return res.status(500).json({ error: "options_not_provided" });
    }
    if (!Array.isArray(repoConfig.terms)) {
      return res.status(500).send({ error: "invalid_terms_format" });
    }
    if (!/^[a-f0-9]+$/.test(repoConfig.commit)) {
      return res.status(500).send({ error: "invalid_commit_format" });
    }

    await repoUtils.getRepoBranches({
      repoConfig,
      token: req.user.accessToken,
    });
    const details = await repoUtils.getRepoDetails({
      repoConfig,
      token: req.user.accessToken,
    });
    if (details.branches[repoConfig.branch] == null) {
      return res.status(500).send({ error: "invalid_branch" });
    }
    if (repoConfig.options.mode == "download") {
      // details.size is in kilobytes
      if (details.size > config.MAX_REPO_SIZE) {
        return res.status(500).send({ error: "non_supported_mode" });
      }
    }

    const data = {
      repoId: repoConfig.repoId,
      fullName: repoConfig.fullName,
      status: "preparing",
      terms: repoConfig.terms,
      owner: req.user.profile.username,
      token: req.user.accessToken,
      branch: repoConfig.branch,
      conference: repoConfig.conference,
      commit: repoConfig.commit
        ? repoConfig.commit
        : details.branches[repoConfig.branch].commit.sha,
      anonymizeDate: new Date(),
      options: {
        expirationMode: repoConfig.options.expirationMode,
        expirationDate: repoConfig.options.expirationDate,
        update: repoConfig.options.update,
        image: repoConfig.options.image,
        pdf: repoConfig.options.pdf,
        notebook: repoConfig.options.notebook,
        loc: repoConfig.options.loc,
        link: repoConfig.options.link,
        mode: repoConfig.options.mode,
        page: repoConfig.options.page,
      },
    };
    if (repoConfig.options.page) {
      data.options.pageSource = details.pageSource;
    }
    await db.get("anonymized_repositories").updateOne(
      {
        repoId: data.repoId,
      },
      {
        $set: data,
      },
      { upsert: true }
    );
    res.send("ok");

    await githubUtils.downloadRepoAndAnonymize(data);
    await repoUtils.updateStatus(repoConfig, "ready");
  } catch (error) {
    console.error(req.path, error);
    await repoUtils.updateStatus(repoConfig, "error", "unable_to_anonymize");
    return res
      .status(500)
      .json({ error: "unable_to_anonymize", message: error.message });
  }
});

module.exports = router;
