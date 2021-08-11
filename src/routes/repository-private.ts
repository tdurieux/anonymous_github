import * as express from "express";
import { ensureAuthenticated } from "./connection";

import * as db from "../database/database";
import { getRepo, getUser, handleError } from "./route-utils";
import RepositoryModel from "../database/repositories/repositories.model";
import {
  GitHubRepository,
  getRepositoryFromGitHub,
} from "../source/GitHubRepository";
import gh = require("parse-github-url");
import GitHubBase from "../source/GitHubBase";
import AnonymizedRepositoryModel from "../database/anonymizedRepositories/anonymizedRepositories.model";
import config from "../../config";
import { IAnonymizedRepositoryDocument } from "../database/anonymizedRepositories/anonymizedRepositories.types";
import Repository from "../Repository";

const router = express.Router();

// user needs to be connected for all user API
router.use(ensureAuthenticated);

// claim a repository
router.post("/claim", async (req: express.Request, res: express.Response) => {
  const user = await getUser(req);
  try {
    if (!req.body.repoId) {
      return res.status(500).json({ error: "repoId_not_defined" });
    }
    if (!req.body.repoUrl) {
      return res.status(500).json({ error: "repoUrl_not_defined" });
    }

    const repoConfig = await db.getRepository(req.body.repoId);
    if (repoConfig == null) {
      return res.status(500).json({ error: "repo_not_found" });
    }

    const r = gh(req.body.repoUrl);
    const repo = await getRepositoryFromGitHub({
      owner: r.owner,
      repo: r.name,
      accessToken: user.accessToken,
    });
    if ((repoConfig.source as GitHubBase).githubRepository.id != repo.id) {
      return res.status(500).json({ error: "repo_not_found" });
    }

    console.log(`${user.username} claims ${r.repository}.`);
    repoConfig.owner = user;

    await AnonymizedRepositoryModel.updateOne(
      { repoId: repoConfig.repoId },
      { $set: { owner: user.username } }
    );
    return res.send("Ok");
  } catch (error) {
    console.error(req.path, error);
    return res.status(500).json({ error });
  }
});

// refresh a repository
router.post(
  "/:repoId/refresh",
  async (req: express.Request, res: express.Response) => {
    const repo = await getRepo(req, res, { nocheck: true });
    if (!repo) return;
    const user = await getUser(req);
    if (repo.owner.username != user.username) {
      return res.status(401).json({ error: "not_authorized" });
    }
    await repo.anonymize();
    res.end("ok");
  }
);

// delete a repository
router.delete(
  "/:repoId/",
  async (req: express.Request, res: express.Response) => {
    const repo = await getRepo(req, res, { nocheck: false });
    if (!repo) return;
    const user = await getUser(req);
    if (repo.owner.username != user.username) {
      return res.status(401).json({ error: "not_authorized" });
    }
    await repo.remove();
    console.log(`${req.params.repoId} is removed`);
    return res.json("ok");
  }
);

router.get(
  "/:owner/:repo/",
  async (req: express.Request, res: express.Response) => {
    const user = await getUser(req);
    try {
      const repo = await getRepositoryFromGitHub({
        owner: req.params.owner,
        repo: req.params.repo,
        accessToken: user.accessToken,
      });
      res.json(repo.toJSON());
    } catch (error) {
      handleError(error, res);
    }
  }
);

router.get(
  "/:owner/:repo/branches",
  async (req: express.Request, res: express.Response) => {
    const user = await getUser(req);
    try {
      const repository = await getRepositoryFromGitHub({
        accessToken: user.accessToken,
        owner: req.params.owner,
        repo: req.params.repo,
      });
      return res.json(
        await repository.branches({
          accessToken: user.accessToken,
          force: req.query.force == "1",
        })
      );
    } catch (error) {
      handleError(error, res);
    }
  }
);

router.get(
  "/:owner/:repo/readme",
  async (req: express.Request, res: express.Response) => {
    const user = await getUser(req);
    const repo = await RepositoryModel.findOne({
      name: `${req.params.owner}/${req.params.repo}`,
    });
    if (!repo) return res.status(404).send({ error: "repo_not_found" });
    const repository = new GitHubRepository(repo);
    return res.send(
      await repository.readme({
        accessToken: user.accessToken,
        force: req.query.force == "1",
        branch: req.query.branch as string,
      })
    );
  }
);

function validateNewRepo(repoUpdate) {
  const validCharacters = /^[0-9a-zA-Z\-\_]+$/;
  if (
    !repoUpdate.repoId.match(validCharacters) ||
    repoUpdate.repoId.length < 3
  ) {
    throw new Error("invalid_repoId");
  }
  if (!repoUpdate.branch) {
    throw new Error("branch_not_specified");
  }
  if (!repoUpdate.options) {
    throw new Error("options_not_provided");
  }
  if (!Array.isArray(repoUpdate.terms)) {
    throw new Error("invalid_terms_format");
  }
  if (!/^[a-f0-9]+$/.test(repoUpdate.commit)) {
    throw new Error("invalid_commit_format");
  }
}

function updateRepoModel(model: IAnonymizedRepositoryDocument, repoUpdate) {
  model.source.commit = repoUpdate.commit;
  model.source.branch = repoUpdate.branch;
  model.conference = repoUpdate.conference;
  model.options = {
    terms: repoUpdate.terms,
    expirationMode: repoUpdate.options.expirationMode,
    expirationDate: repoUpdate.options.expirationDate
      ? new Date(repoUpdate.options.expirationDate)
      : null,
    update: repoUpdate.options.update,
    image: repoUpdate.options.image,
    pdf: repoUpdate.options.pdf,
    notebook: repoUpdate.options.notebook,
    link: repoUpdate.options.link,
    page: repoUpdate.options.page,
    pageSource: repoUpdate.options.pageSource,
  };
}
// update a repository
router.post(
  "/:repoId/",
  async (req: express.Request, res: express.Response) => {
    const repo = await getRepo(req, res, { nocheck: true });
    if (!repo) return;
    const user = await getUser(req);

    if (repo.owner.username != user.username) {
      return res.status(401).json({ error: "not_authorized" });
    }

    const repoUpdate = req.body;

    try {
      validateNewRepo(repoUpdate);
    } catch (error) {
      return handleError(error, res);
    }

    if (repoUpdate.commit != repo.model.source.commit) {
      repo.model.anonymizeDate = new Date();
      repo.model.source.commit = repoUpdate.commit;
      await repo.remove();
    }

    updateRepoModel(repo.model, repoUpdate);

    await repo.updateStatus("preparing");

    await repo.model.save();
    res.send("ok");
    new Repository(repo.model).anonymize();
  }
);

// add repository
router.post("/", async (req: express.Request, res: express.Response) => {
  const user = await getUser(req);
  const repoUpdate = req.body;

  try {
    validateNewRepo(repoUpdate);
  } catch (error) {
    return handleError(error, res);
  }
  const r = gh(repoUpdate.fullName);
  const repository = await getRepositoryFromGitHub({
    accessToken: user.accessToken,
    owner: r.owner,
    repo: r.name,
  });
  const repo = new AnonymizedRepositoryModel();
  repo.repoId = repoUpdate.repoId;
  repo.anonymizeDate = new Date();
  repo.owner = user.username;
  repo.source = {
    type:
      repoUpdate.options.mode == "download" ? "GitHubDownload" : "GitHubStream",
    accessToken: user.accessToken,
    repositoryId: repository.model.id,
    repositoryName: repoUpdate.fullName,
  };

  if (repo.source.type == "GitHubDownload") {
    // details.size is in kilobytes
    if (repository.size > config.MAX_REPO_SIZE) {
      return res.status(500).send({ error: "invalid_mode" });
    }
  }

  updateRepoModel(repo, repoUpdate);

  await repo.save();
  res.send("ok");
  new Repository(repo).anonymize();
});

export default router;
