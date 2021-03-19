const express = require("express");
const path = require("path");

const db = require("../utils/database");
const fileUtils = require("../utils/file");
const repoUtils = require("../utils/repository");
const githubUtils = require("../utils/github");

const router = express.Router();

async function anonymizeRepository(options) {
  let repoConfig = options.repoConfig;
  if (!repoConfig) {
    repoConfig = await repoUtils.getConfig(options.repoId);
  }

  if (repoConfig == null) {
    throw "repo_not_found";
  }

  if (repoConfig.options.expirationMode != "never") {
    if (repoConfig.options.expirationDate <= new Date()) {
      console.log("The repository is expired");
      await repoUtils.updateStatus(repoConfig, "expired");
      await repoUtils.removeRepository(repoConfig);
      throw "repository_expired";
      return;
    }
  }

  const lastView = repoConfig.lastView;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  if (repoConfig.options.update && lastView < yesterday) {
    console.log("check for updates in the repository.");
    try {
    } catch (error) {
      console.error("Error while updating the repository.");
      console.error(error);
    }
    await repoUtils.updateAnonimizedRepository(repoConfig);
  }
  await githubUtils.downloadRepoAndAnonymize(repoConfig);
}

router.get("/:repoId/files", async (req, res) => {
  const repoConfig = await repoUtils.getConfig(req.params.repoId);
  if (repoConfig == null) {
    return res.status(500).json({ error: "repo_not_found" });
  }

  if (repoConfig.status != "ready") {
    return res.status(500).json({ error: "repo_not_ready" });
  }

  try {
    const files = await fileUtils.getFileList({ repoConfig });
    return res.json(files);
  } catch (error) {
    return res.status(500).json({ error });
  }
});

router.get("/:repoId/stats", async (req, res) => {
  const repoConfig = await repoUtils.getConfig(req.params.repoId);

  if (repoConfig == null) {
    return res.status(500).json({ error: "repo_not_found" });
  }
  if (repoConfig.status != "ready") {
    return res.status(500).json({ error: "repo_not_ready" });
  }

  if (repoConfig.options.mode == "stream") {
    return res.status(500).json({ error: "stream_not_supported" });
  }

  try {
    const stats = await fileUtils.getStats({ repoConfig });
    return res.json(stats.languages);
  } catch (error) {
    console.log(error);
    return res.status(500).json({ error });
  }
});

router.get("/:repoId/options", async (req, res) => {
  const repoConfig = await repoUtils.getConfig(req.params.repoId);
  if (repoConfig == null) {
    return res.status(500).json({ error: "repo_not_found" });
  }
  try {
    try {
      await anonymizeRepository({ repoConfig });
    } catch (error) {
      console.log("Error during the anonymization of the repository");
      console.log(error);
    }
    if (repoConfig.status == "removed") {
      throw "repository_expired";
    }
    if (repoConfig.status == "expired") {
      if (repoConfig.options.expirationMode == "redirect") {
        repoConfig.options.url = "https://github.com/" + repoConfig.fullName;
      } else {
        throw "repository_expired";
      }
    } else if (repoConfig.status != "ready") {
      throw "repository_not_ready";
    }

    return res.json(repoConfig.options);
  } catch (error) {
    console.log(error);
    return res.status(500).json({ error });
  }
});

router.get("/:repoId/file/:path*", async (req, res) => {
  const repoConfig = await repoUtils.getConfig(req.params.repoId);

  if (repoConfig == null) {
    return res.status(500).json({ error: "repo_not_found" });
  }
  if (repoConfig.status != "ready") {
    return res.status(500).json({ error: "repo_not_ready" });
  }

  let requestPath = req.params.path;
  if (req.params[0]) {
    requestPath += req.params[0];
  }

  try {
    const isValid = await fileUtils.isFilePathValid({
      repoConfig,
      path: requestPath,
    });
    if (isValid) {
      await db
        .get("anonymized_repositories")
        .updateOne(
          { repoId: repoConfig.repoId },
          { $set: { lastView: new Date() }, $inc: { pageView: 1 } }
        );
      const ppath = path.join(
        repoUtils.getAnonymizedPath(repoConfig.repoId),
        requestPath
      );
      return res.sendFile(ppath, { dotfiles: "allow" });
    } else {
      return res.status(404).json({ error: "file_not_found" });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).send({ error });
  }
});

module.exports = router;
