const fs = require("fs").promises;
const ofs = require("fs");
const path = require("path");
const gh = require("parse-github-url");
const { Octokit } = require("@octokit/rest");

const config = require("./config");
const db = require("./utils/database");
const repoUtils = require("./utils/repository");
const fileUtils = require("./utils/file");
const githubUtils = require("./utils/github");

// const ROOT = "./repositories";
const ROOT = "./repo";
(async () => {
  await db.connect();
  const repositories = await fs.readdir(ROOT);
  let index = 0;
  for (let repo of repositories) {
    // for (let repo of ["14bfc5c6-b794-487e-a58a-c54103a93c7b"]) {
    console.log("Import ", index++, "/", repositories.length, " ", repo);
    try {
      const conf = await repoUtils.getConfig(repo);
      if (conf) {
        continue;
      }
      // const repoPath = path.join("./repositories", repo);
      const repoPath = path.join(ROOT, repo);
      const configPath = path.join(repoPath, "config.json");
      if (!ofs.existsSync(configPath)) {
        continue;
      }
      const repoConfig = JSON.parse(await fs.readFile(configPath));
      const r = gh(repoConfig.repository);
      if (r == null) {
        console.log(`${repoConfig.repository} is not a valid github url.`);
        continue;
      }
      const fullName = `${r.owner}/${r.name}`;

      // const octokit = new Octokit({ auth: config.GITHUB_TOKEN });
      // try {
      //   await octokit.apps.checkToken({
      //     client_id: config.CLIENT_ID,
      //     access_token: repoConfig.token,
      //   });
      // } catch (error) {
      //   delete repoConfig.token;
      //   continue
      // }
      let token = repoConfig.token;

      if (!token) {
        token = config.GITHUB_TOKEN;
      }

      const branches = await repoUtils.getRepoBranches({
        fullName,
        token,
      });
      const details = await repoUtils.getRepoDetails({
        fullName,
        token,
      });
      let branch = details.default_branch;
      if (r.branch && branches[r.branch]) {
        branch = r.branch;
      }
      if (!branches[branch]) {
        console.log(branch, details.default_branch, branches);
      }
      let commit = branches[branch].commit.sha;
      const anonymizeDate = new Date();

      let mode = "stream";
      // if (details.size < 1024) {
      //   mode = "download";
      // }

      let expirationDate = null;
      if (repoConfig.expiration_date) {
        expirationDate = new Date(repoConfig.expiration_date["$date"]);
      }
      const expirationMode = repoConfig.expiration
        ? repoConfig.expiration
        : "never";

      const repoConfiguration = {
        repoId: repo,
        fullName,
        // owner: "tdurieux",
        owner: r.owner,
        terms: repoConfig.terms,
        repository: repoConfig.repository,
        token: repoConfig.token,
        branch,
        commit,
        anonymizeDate,
        options: {
          image: false,
          mode,
          expirationMode,
          expirationDate,
          update: true,
          page: details.has_pages,
          pdf: false,
          notebook: true,
          loc: false,
          link: true,
        },
      };
      await db.get("anonymized_repositories").updateOne(
        {
          repoId: repo,
        },
        {
          $set: repoConfiguration,
        },
        { upsert: true }
      );
      if (ofs.existsSync(repoUtils.getOriginalPath(repo))) {
        await fs.rm(repoUtils.getOriginalPath(repo), {
          recursive: true,
          force: true,
        });
      }
      if (ofs.existsSync(repoUtils.getAnonymizedPath(repo))) {
        await fs.rm(repoUtils.getAnonymizedPath(repo), {
          recursive: true,
          force: true,
        });
      }
      // await githubUtils.downloadRepoAndAnonymize(repoConfiguration);
      // await fileUtils.getFileList({ repoConfig: repoConfiguration });
      await repoUtils.updateStatus(repoConfiguration, "ready");
      console.log(
        expirationDate,
        expirationDate != null && expirationDate < new Date(),
        expirationDate < new Date()
      );
      if (
        expirationMode != "never" &&
        expirationDate != null &&
        expirationDate < new Date()
      ) {
        await repoUtils.updateStatus(repoConfiguration, "expired");
      }
    } catch (error) {
      console.error(error);
    }
  }
  await db.close();
})();
