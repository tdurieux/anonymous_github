const ofs = require("fs");
const { OAuthApp } = require("@octokit/oauth-app");

const db = require("./database");
const repoUtils = require("./repository");
const fileUtils = require("./file");

const config = require("../config");

const app = new OAuthApp({
  clientType: "github-app",
  clientId: config.CLIENT_ID,
  clientSecret: config.CLIENT_SECRET,
});

module.exports.getToken = async (repoConfig) => {
  if (repoConfig.owner) {
    const user = await db
      .get()
      .collection("users")
      .findOne(
        { username: repoConfig.owner },
        { projection: { accessToken: 1 } }
      );
    if (user && user.accessToken) {
      return user.accessToken;
    }
  }
  if (repoConfig.token) {
    try {
      await app.checkToken({
        token: repoConfig.token,
      });
      return repoConfig.token;
    } catch (error) {
      console.debug("Token is invalid.", error);
      delete repoConfig.token;
    }
  }
  return config.GITHUB_TOKEN;
};

module.exports.downloadRepoAndAnonymize = async (repoConfig) => {
  const cachePath = repoUtils.getAnonymizedPath(repoConfig.repoId);
  const originalPath = repoUtils.getOriginalPath(repoConfig.repoId);
  if (ofs.existsSync(cachePath) || ofs.existsSync(originalPath)) {
    return true;
  }
  if (repoConfig.options.mode == "download") {
    // if cache folder does not exist download and anonymize it

    const originalPath = repoUtils.getOriginalPath(repoConfig.repoId);

    await repoUtils.updateStatus(repoConfig, "downloading");
    await repoUtils.downloadOriginalRepo(repoConfig, originalPath);
    await repoUtils.updateStatus(repoConfig, "ready");

    // anonymize all the files
    // await repoUtils.updateStatus(repoConfig, "anonymize");

    // await anonymizeUtils.anonymizeFolder(originalPath, cachePath, repoConfig);
    // await repoUtils.updateStatus(repoConfig, "anonymized");

    // clean up
    // await fs.rm(originalPath, { recursive: true, force: true });
    return true;
  } else if (repoConfig.options.mode == "stream") {
    // in stream mode only download the list of file from github
    await repoUtils.updateStatus(repoConfig, "downloading");
    await fileUtils.getFileList({ repoConfig });
    await repoUtils.updateStatus(repoConfig, "ready");
    return true;
  }
  return false;
};
