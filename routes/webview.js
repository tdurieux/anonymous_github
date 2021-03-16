const express = require("express");
const path = require("path");

const fileUtils = require("../utils/file");
const repoUtils = require("../utils/repository");

const router = express.Router();

async function webView(req, res) {
  try {
    const repoId = req.params.repoId;
    const repoConfig = await repoUtils.getConfig(repoId);

    if (!repoConfig.options.page) {
      throw "page_not_activated";
    }
    if (!repoConfig.options.pageSource) {
      throw "page_not_activated";
    }

    if (repoConfig.options.pageSource.branch != repoConfig.branch) {
      throw "page_not_supported_on_different_branch";
    }

    let requestPath = req.path.substring(
      req.path.indexOf(repoId) + repoId.length
    );

    if (requestPath[requestPath.length - 1] == "/") {
      requestPath = path.join(requestPath, "index.html");
    }
    // TODO: handle website that are not in the docs folder (master, docs, gh-pages)
    requestPath = path.join(repoConfig.options.pageSource.path, requestPath);

    if (await fileUtils.isFilePathValid({ repoConfig, path: requestPath })) {
      const ppath = path.join(
        repoUtils.getAnonymizedPath(repoConfig.repoId),
        requestPath
      );
      return res.sendFile(ppath, { dotfiles: "allow" }, (err) => {
        if (err) {
          if (err.path) {
            const newPath = path.join(
              req.path,
              err.path.replace(
                path.join(
                  repoUtils.getAnonymizedPath(repoConfig.repoId),
                  "docs"
                ),
                ""
              )
            );
            if (newPath != req.path) {
              return res.redirect(newPath);
            }
          }
        }
        console.log(err);
      });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).send({ error });
  }
  return res.status(404).send("File_not_found");
}

router.get("/:repoId/*", webView);

module.exports = router;
