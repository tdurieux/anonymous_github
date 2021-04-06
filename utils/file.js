const ofs = require("fs");
const fs = require("fs").promises;
const path = require("path");
const { Octokit } = require("@octokit/rest");
const gh = require("parse-github-url");
const loc = require("@umijs/linguist");
const { isText } = require("istextorbinary");

const db = require("./database");
const repoUtils = require("./repository");
const githubUtils = require("./github");
const anonymizeUtils = require("./anonymize");
const config = require("../config");

async function walk(dir, root) {
  if (root == null) {
    root = dir;
  }
  let files = await fs.readdir(dir);
  const output = { child: {} };
  for (let file of files) {
    let filePath = path.join(dir, file);
    const stats = await fs.stat(filePath);
    if (file[0] == "$") {
      file = "\\" + file;
    }
    if (stats.isDirectory()) {
      output.child[file] = await walk(filePath, root);
      output.child[file].sha = stats.ino;
    } else if (stats.isFile()) {
      output.child[file] = { size: stats.size, sha: stats.ino };
    }
  }
  return output;
}
function tree2tree(tree, partialTree, parentPath) {
  if (!parentPath) parentPath = "";
  if (partialTree == null) {
    partialTree = { child: Object.create(null) };
  }
  for (let elem of tree) {
    const paths = path.join(parentPath, elem.path).split("/");
    let current = partialTree;

    // if elem is a folder iterate on all folders if it is a file stop before the filename
    const end = elem.type == "tree" ? paths.length : paths.length - 1;
    for (let i = 0; i < end; i++) {
      let p = paths[i];
      if (p[0] == "$") {
        p = "\\" + p;
      }
      if (!current.child[p]) {
        current.child[p] = {
          child: Object.create(null),
        };
      }
      current = current.child[p];
    }

    // if elem is a file add the file size in the file list
    if (elem.type == "blob") {
      let p = paths[end];
      if (p[0] == "$") {
        p = "\\" + p;
      }
      current.child[p] = {
        size: elem.size,
        sha: elem.sha,
      };
    } else {
      current.sha = elem.sha;
    }
  }
  return partialTree;
}
async function getTruncatedTree(repoConfig, truncatedTree, sha, parentPath) {
  const repo = gh(repoConfig.fullName);

  if (!sha) {
    sha = repoConfig.commit ? repoConfig.commit : "HEAD";
  }

  const octokit = new Octokit({
    auth: await githubUtils.getToken(repoConfig),
  });
  const ghRes = await octokit.git.getTree({
    owner: repo.owner,
    repo: repo.name,
    tree_sha: sha,
  });
  const tree = ghRes.data.tree;

  for (let elem of tree) {
    if (elem.type == "tree") {
      const elementPath = path.join(parentPath, elem.path);
      const paths = elementPath.split("/");

      let current = truncatedTree;
      for (let i = 0; i < paths.length; i++) {
        let p = paths[i];
        if (!current.child[p]) {
          await module.exports.getTree(
            repoConfig,
            elem.sha,
            truncatedTree,
            elementPath
          );
          break;
        }
        current = current.child[p];
      }
    }
  }

  tree2tree(ghRes.data.tree, truncatedTree, parentPath);

  return truncatedTree;
}
module.exports.getTree = async (repoConfig, sha, truncatedTree, parentPath) => {
  const repo = gh(repoConfig.fullName);

  if (!sha) {
    sha = repoConfig.commit ? repoConfig.commit : "HEAD";
  }
  if (!parentPath) parentPath = "";

  const octokit = new Octokit({
    auth: await githubUtils.getToken(repoConfig),
  });
  const ghRes = await octokit.git.getTree({
    owner: repo.owner,
    repo: repo.name,
    tree_sha: sha,
    recursive: true,
  });

  const tree = tree2tree(ghRes.data.tree, truncatedTree, parentPath);
  if (ghRes.data.truncated) {
    await getTruncatedTree(repoConfig, tree, sha, parentPath);
  }
  return tree;
};
module.exports.getFileList = async (options) => {
  let repoConfig = options.repoConfig;
  if (!repoConfig) {
    repoConfig = await repoUtils.getConfig(options.repoId);
  }

  if (repoConfig == null) {
    throw "repo_not_found";
  }

  const r = await db.get("anonymized_repositories").findOne(
    { repoId: repoConfig.repoId },
    {
      projection: { files: 1 },
    }
  );
  if (r && r.files) {
    return r.files;
  }

  if (repoConfig.options.mode == "stream") {
    // get file list from github
    const tree = await module.exports.getTree(repoConfig, repoConfig.commit);
    const files = anonymizeTree(tree, repoConfig);
    await db.get("anonymized_repositories").updateOne(
      { repoId: repoConfig.repoId },
      {
        $set: {
          originalFiles: tree.child,
          files,
        },
      },
      { upsert: true }
    );
    return files;
  } else if (repoConfig.options.mode == "download") {
    const originalFiles = await walk(
      repoUtils.getOriginalPath(repoConfig.repoId)
    );
    const files = anonymizeTree(originalFiles, repoConfig);
    await db.get("anonymized_repositories").updateOne(
      { repoId: repoConfig.repoId },
      {
        $set: {
          originalFiles: originalFiles.child,
          files,
        },
      },
      { upsert: true }
    );
    return files;
  } else {
    throw "non_supported_mode";
  }
};
function anonymizeTree(tree, repoConfig) {
  if (Number.isInteger(tree.size)) {
    return tree;
  }
  const output = {};
  for (let file in tree.child) {
    const anonymizedPath = anonymizeUtils.anonymizePath(file, repoConfig);
    output[anonymizedPath] = anonymizeTree(tree.child[file], repoConfig);
  }
  return output;
}

function tree2sha(tree, output, parent) {
  if (!output) {
    output = {};
    parent = "";
  }
  for (let i in tree) {
    if (tree[i].sha) {
      output[tree[i].sha] = path.join(parent, i);
    }
    if (tree[i].child) {
      tree2sha(tree[i].child, output, path.join(parent, i));
    }
  }
  return output;
}

function getFile(tree, elementPath) {
  const paths = elementPath.trim().split("/");
  let current = tree;
  if (!tree.child) {
    current = { child: tree };
  }
  for (let i = 0; i < paths.length; i++) {
    let p = paths[i];
    if (p == "") {
      continue;
    }
    let tmp = current;
    if (current.child) {
      tmp = current.child;
    }
    if (!tmp[p]) {
      return null;
    }
    current = tmp[p];
  }
  return current;
}
module.exports.additionalExtensions = [
  "license",
  "dockerfile",
  "sbt",
  "ipynb",
  "gp",
  "out",
  "sol",
];
module.exports.isText = (p) => {
  if (isText(p)) {
    return true;
  }
  const filename = path.basename(p);
  const extensions = filename.split(".").reverse();
  const extension = extensions[0].toLowerCase();
  if (module.exports.additionalExtensions.includes(extension)) {
    return true;
  }
  return false;
};
module.exports.isFileSupported = (repoConfig, p) => {
  if (module.exports.isText(p)) {
    return true;
  }

  const filename = path.basename(p);
  const extensions = filename.split(".").reverse();
  const extension = extensions[0].toLowerCase();

  if (repoConfig.options.pdf && extension == "pdf") {
    return true;
  }
  if (
    repoConfig.options.image &&
    (extension == "png" ||
      extension == "jpg" ||
      extension == "jpeg" ||
      extension == "gif")
  ) {
    return true;
  }
  return false;
};
module.exports.isFilePathValid = async (options) => {
  if (options.path == null) {
    throw "invalid_path";
  }
  let repoConfig = options.repoConfig;
  if (!repoConfig) {
    repoConfig = await repoUtils.getConfig(options.repoId);
  }

  if (repoConfig == null) {
    throw "repo_not_found";
  }
  if (repoConfig.status == "expired") {
    throw "repository_expired";
  }
  if (repoConfig.status == "removed") {
    throw "repository_expired";
  }
  if (repoConfig.status != "ready") {
    throw "repository_not_ready";
  }

  const anonymizedFilePath = path.join(
    repoUtils.getAnonymizedPath(repoConfig.repoId),
    options.path
  );

  if (!module.exports.isFileSupported(repoConfig, anonymizedFilePath)) {
    throw "file_not_supported";
  }

  let anonymizePath = options.path;
  if (anonymizePath.indexOf("XXX") > -1) {
    const files = await module.exports.getFileList({ repoConfig });

    const file = getFile(files, options.path);
    if (file) {
      const r = await db
        .get("anonymized_repositories")
        .findOne(
          { repoId: repoConfig.repoId },
          { projection: { originalFiles: 1 } }
        );

      const shatree = tree2sha(r.originalFiles);
      if (shatree[file.sha]) {
        anonymizePath = shatree[file.sha];
      }
    }
  }
  const originalFilePath = path.join(
    repoUtils.getOriginalPath(repoConfig.repoId),
    anonymizePath
  );
  if (ofs.existsSync(anonymizedFilePath)) {
    return true;
  }
  if (ofs.existsSync(originalFilePath)) {
    if (!module.exports.isFileSupported(repoConfig, anonymizedFilePath)) {
      throw "file_not_supported";
    }
    await anonymizeUtils.anonymizeFile(
      originalFilePath,
      anonymizedFilePath,
      repoConfig
    );
    return true;
  }
  // if stream mode check download the file
  if (repoConfig.options.mode == "stream") {
    const repo = gh(repoConfig.fullName);
    const files = await module.exports.getFileList({ repoConfig });
    let file = getFile(files, options.path);
    if (file == null) {
      throw "file_not_found";
    }
    if (!file.sha) {
      throw "is_folder";
    }
    if (file.size > config.MAX_FILE_SIZE) {
      // file bigger than 10mb
      throw "file_too_big";
    }
    const octokit = new Octokit({
      auth: await githubUtils.getToken(repoConfig),
    });

    let ghRes = null;
    if (file) {
      if (!module.exports.isFileSupported(repoConfig, anonymizedFilePath)) {
        throw "file_not_supported";
      }
      try {
        ghRes = await octokit.request(
          "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
          {
            owner: repo.owner,
            repo: repo.name,
            file_sha: file.sha,
          }
        );
      } catch (error) {
        if (error.status == 401 && config.GITHUB_TOKEN) {
          try {
            response = await getZip(config.GITHUB_TOKEN);
          } catch (error) {
            throw "repo_not_accessible";
          }
        } else if (error.status == 403) {
          throw "file_too_big";
        }
        console.error(error);
        throw "file_not_accessible";
      }
    } else {
      try {
        ghRes = await octokit.repos.getContents({
          owner: repo.owner,
          repo: repo.name,
          path: options.path,
          ref: repoConfig.commit ? repoConfig.commit : "HEAD",
        });
      } catch (error) {
        if (error.status == 404) {
          return false;
        }
        if (error.status == 403) {
          console.log(error);
          throw "file_too_big";
        }
        throw error;
      }
    }
    if (!ghRes.data.content && ghRes.data.size != 0) {
      throw "file_not_accessible";
    }
    // empty file
    let content = "";
    if (ghRes.data.content) {
      content = new Buffer.from(ghRes.data.content, ghRes.data.encoding);
    }

    try {
      await fs.mkdir(path.dirname(originalFilePath), { recursive: true });
    } catch (_) {
      // ignore
    }
    try {
      await fs.writeFile(originalFilePath, content, { encoding: "utf-8" });
      await anonymizeUtils.anonymiseFile(
        originalFilePath,
        anonymizedFilePath,
        repoConfig
      );
    } catch (error) {
      console.error(error);
      throw "unable_to_write_file";
    }
    return true;
  }
  return false;
};

module.exports.getStats = async (options) => {
  let repoConfig = options.repoConfig;
  if (!repoConfig) {
    repoConfig = await repoUtils.getConfig(options.repoId);
  }

  if (repoConfig == null) {
    throw "repo_not_found";
  }
  if (repoConfig.options.mode != "download") {
    throw "stats_unsupported";
  }

  if (repoConfig.loc) {
    return repoConfig.loc;
  }

  const repoCache = repoUtils.getOriginalPath(repoConfig.repoId);
  try {
    await fs.access(repoCache, ofs.constants.R_OK);
  } catch (error) {
    throw "repo_not_found";
  }
  const o = loc(repoCache);

  await db.get("anonymized_repositories").updateOne(
    { repoId: repoConfig.repoId },
    {
      $set: {
        loc: o,
      },
    },
    { upsert: true }
  );
  return o;
};
