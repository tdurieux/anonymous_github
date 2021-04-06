const fs = require("fs").promises;
const ofs = require("fs");
const path = require("path");
const gh = require("parse-github-url");
const { Octokit } = require("@octokit/rest");
const extract = require("extract-zip");

const db = require("./database");
const githubUtils = require("./github");
const config = require("../config");

module.exports.getPath = (repoId) => {
  return path.resolve(__dirname, "..", "repositories", repoId);
};
module.exports.getOriginalPath = (repoId) => {
  return path.resolve(__dirname, "..", "repositories", repoId, "original");
};
module.exports.getAnonymizedPath = (repoId) => {
  return path.resolve(__dirname, "..", "repositories", repoId, "cache");
};

module.exports.getConfig = async (repoId) => {
  const repo = await db
    .get()
    .collection("anonymized_repositories")
    .findOne(
      { repoId },
      {
        projection: {
          // files: 1,
          token: 1,
          branch: 1,
          commit: 1,
          owner: 1,
          fullName: 1,
          repoId: 1,
          terms: 1,
          options: 1,
          loc: 1,
          status: 1,
          lastView: 1,
        },
      }
    );

  if (repo && repo.options.expirationDate) {
    repo.options.expirationDate = new Date(repo.options.expirationDate);
    repo.lastView = new Date(repo.lastView);
  }
  return repo;
};

module.exports.getRepoDetails = async (options) => {
  const query = {};
  if (options.fullName) {
    query.fullName = options.fullName;
  } else if (options.repoConfig) {
    query.fullName = options.repoConfig.fullName;
    options.fullName = query.fullName;
  } else if (options.owner && options.repo) {
    query.fullName = `${options.owner}/${options.repo}`;
    options.fullName = query.fullName;
  } else {
    throw "invalid_options";
  }

  if (options.force !== true) {
    const repository = await db
      .get("repositories")
      .findOne(query, { projection: { readme: 0 } });
    if (repository && repository.id) return repository;
  }

  try {
    const repo = gh(options.fullName);

    const octokit = new Octokit({ auth: options.token });
    let ghRes = await octokit.repos.get({
      owner: repo.owner,
      repo: repo.name,
    });
    ghRes.data.fullName = ghRes.data.full_name;
    if (ghRes.data.fullName != query.fullName) {
      // repo renamed keep the old name
      ghRes.data.fullName = query.fullName;
    }
    if (ghRes.data.has_pages) {
      ghPageRes = await octokit.request("GET /repos/{owner}/{repo}/pages", {
        owner: repo.owner,
        repo: repo.name,
      });
      ghRes.data.pageSource = ghPageRes.data.source;
    }

    delete ghRes.data.full_name;
    await db
      .get("repositories")
      .updateOne(query, { $set: ghRes.data }, { upsert: true });
    return ghRes.data;
  } catch (error) {
    console.log(query, error);
    if (error.status == 401 && options.token != config.GITHUB_TOKEN) {
      options.token = config.GITHUB_TOKEN;
      return await module.exports.getRepoDetails(options);
    }
    throw "repo_not_found";
  }
};

module.exports.downloadRepoZip = async (repoConfig, target) => {
  const repo = gh(repoConfig.fullName);

  async function getZip(token) {
    const octokit = new Octokit({ auth: token });
    return await octokit.request("GET /repos/{owner}/{repo}/zipball/{ref}", {
      owner: repo.owner,
      repo: repo.name,
      ref: repoConfig.commit,
    });
  }
  let response = null;
  try {
    response = await getZip(await githubUtils.getToken(repoConfig));
  } catch (error) {
    if (error.status == 401 && config.GITHUB_TOKEN) {
      try {
        response = await getZip(config.GITHUB_TOKEN);
      } catch (error) {
        throw "repo_not_accessible";
      }
    } else {
      throw "repo_not_accessible";
    }
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.from(response.data), {
    encoding: "binary",
  });
};

module.exports.updateStatus = async (repoConfig, status, errorMessage) => {
  repoConfig.status = status;
  repoConfig.errorMessage = errorMessage;
  const update = { $set: { status } };
  if (!errorMessage) {
    update["$unset"] = { errorMessage: "" };
  } else {
    update["$set"].errorMessage = errorMessage;
  }

  await db
    .get("anonymized_repositories")
    .updateOne({ repoId: repoConfig.repoId }, update);
};

module.exports.downloadOriginalRepo = async (repoConfig, destination) => {
  const zipPath = path.join(
    module.exports.getPath(repoConfig.repoId),
    "content.zip"
  );
  const destinationZip = destination + "_zip";

  // download the repository and unzip it
  await module.exports.downloadRepoZip(repoConfig, zipPath);
  await extract(zipPath, { dir: destinationZip });

  const folders = await fs.readdir(destinationZip);
  fs.rename(path.join(destinationZip, folders[0]), destination);
  await fs.rm(zipPath);
  await fs.rm(destinationZip, { recursive: true });
};

module.exports.getAnonymizedRepoDetails = async (repoId, user) => {
  return db.get("anonymized_repositories").findOne(
    {
      repoId,
      owner: user.username,
    },
    { projection: { token: 0, files: 0, originalFiles: 0, loc: 0 } }
  );
};

module.exports.getRepoCommit = async (options) => {
  let repoConfig = options.repoConfig;
  if (!repoConfig) {
    repoConfig = await module.exports.getConfig(options.repoId);
  }

  if (repoConfig == null) {
    throw "repo_not_found";
  }

  if (options.force !== true) {
    const query = { fullName: repoConfig.fullName };
    query["branches." + repoConfig.branch + ""] = { $exists: true };
    const repository = await db
      .get("repositories")
      .findOne(query, { projection: { branches: 1 } });
    if (
      repository &&
      repository.branches &&
      repository.branches[repoConfig.branch]
    )
      return repository.branches[repoConfig.branch].commit.sha;
  }
  const branches = await module.exports.getRepoBranches({
    repoConfig,
    token: await githubUtils.getToken(repoConfig),
    force: options.force,
  });
  if (!branches[repoConfig.branch]) {
    throw "branch_not_found";
  }
  return branches[repoConfig.branch].commit.sha;
};

module.exports.getRepoBranches = async (options) => {
  const query = {};
  if (options.fullName) {
    query.fullName = options.fullName;
  } else if (options.repoConfig) {
    query.fullName = options.repoConfig.fullName;
    options.fullName = query.fullName;
  } else if (options.owner && options.repo) {
    query.fullName = `${options.owner}/${options.repo}`;
    options.fullName = query.fullName;
  } else {
    throw new Error("Invalid options");
  }

  if (options.force !== true) {
    let repository = await db
      .get("repositories")
      .findOne(query, { projection: { branches: 1 } });
    if (repository && repository.branches) return repository.branches;
  }

  try {
    const repo = gh(options.fullName);

    const octokit = new Octokit({ auth: options.token });
    const data = await octokit.paginate(octokit.repos.listBranches, {
      owner: repo.owner,
      repo: repo.name,
      per_page: 100,
    });

    const branches = {};
    for (let b of data) {
      branches[b.name] = b;
    }
    await db
      .get("repositories")
      .updateOne(query, { $set: { branches } }, { upsert: true });
    return branches;
  } catch (error) {
    if (error.status == 401 && options.token != config.GITHUB_TOKEN) {
      options.token = config.GITHUB_TOKEN;
      return await module.exports.getRepoBranches(options);
    }
    if (error.status == 404) {
      throw "repo_not_found";
    }
    console.error(error);
    throw "branches_not_found";
  }
};

module.exports.getRepoReadme = async (options) => {
  const query = {};
  if (options.fullName) {
    query.fullName = options.fullName;
  } else if (options.repoConfig) {
    query.fullName = options.repoConfig.fullName;
    options.fullName = query.fullName;
  } else if (options.owner && options.repo) {
    query.fullName = `${options.owner}/${options.repo}`;
    options.fullName = query.fullName;
  } else {
    throw new Error("Invalid options");
  }

  if (options.force !== true) {
    let repository = await db
      .get("repositories")
      .findOne(query, { projection: { readme: 1 } });
    if (repository && repository.readme) return repository.readme;
  }

  try {
    const repo = gh(options.fullName);

    const octokit = new Octokit({ auth: options.token });
    const ghRes = await octokit.repos.getReadme({
      owner: repo.owner,
      repo: repo.name,
    });
    const readme = new Buffer.from(ghRes.data.content, "base64").toString(
      "utf-8"
    );
    await db
      .get("repositories")
      .updateOne(query, { $set: { readme } }, { upsert: true });
    return readme;
  } catch (error) {
    throw "readme_not_available";
  }
};

module.exports.updateAnonymizedRepository = async (repoConfig) => {
  if (repoConfig.status == "updating") {
    throw "repo_is_updating";
  }
  repoConfig = await module.exports.getConfig(repoConfig.repoId);
  if (repoConfig.status == "updating") {
    throw "repo_is_updating";
  }
  // check new commit
  const commit = await module.exports.getRepoCommit({
    repoConfig,
    force: true,
  });
  if (commit == repoConfig.commit) {
    console.log(`${repoConfig.repoId} is up to date`);
    return true;
  }
  console.log(`${repoConfig.repoId} will be updated to ${commit}`);
  await module.exports.updateStatus(repoConfig, "updating");
  await db
    .get("anonymized_repositories")
    .updateOne({ repoId: repoConfig.repoId }, { $set: { commit } });
  await module.exports.removeRepository(repoConfig);
  await githubUtils.downloadRepoAndAnonymize(repoConfig);
  await module.exports.updateStatus(repoConfig, "ready");
};

module.exports.removeRepository = async (repoConfig) => {
  try {
    if (ofs.existsSync(module.exports.getOriginalPath(repoConfig.repoId))) {
      await fs.rm(module.exports.getOriginalPath(repoConfig.repoId), {
        recursive: true,
        force: true,
      });
    }
    if (ofs.existsSync(module.exports.getAnonymizedPath(repoConfig.repoId))) {
      await fs.rm(module.exports.getAnonymizedPath(repoConfig.repoId), {
        recursive: true,
        force: true,
      });
    }

    await db
      .get("anonymized_repositories")
      .updateOne(
        { repoId: repoConfig.repoId },
        { $unset: { files: "", originalFiles: "", loc: "" } }
      );
  } catch (error) {
    console.log(error);
    throw error;
  }
};
