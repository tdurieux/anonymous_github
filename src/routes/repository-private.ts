import * as express from "express";
import { ensureAuthenticated } from "./connection";

import * as db from "../database/database";
import { getRepo, getUser, handleError } from "./route-utils";
import { getRepositoryFromGitHub } from "../source/GitHubRepository";
import gh = require("parse-github-url");
import GitHubBase from "../source/GitHubBase";
import AnonymizedRepositoryModel from "../database/anonymizedRepositories/anonymizedRepositories.model";
import config from "../../config";
import { IAnonymizedRepositoryDocument } from "../database/anonymizedRepositories/anonymizedRepositories.types";
import Repository from "../Repository";
import ConferenceModel from "../database/conference/conferences.model";
import AnonymousError from "../AnonymousError";

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
      { $set: { owner: user.model.id } }
    );
    return res.send("Ok");
  } catch (error) {
    handleError(error, res);
  }
});

// refresh repository
router.post(
  "/:repoId/refresh",
  async (req: express.Request, res: express.Response) => {
    try {
      const repo = await getRepo(req, res, { nocheck: true });
      if (!repo) return;

      const user = await getUser(req);
      if (repo.owner.id != user.id) {
        return res.status(401).json({ error: "not_authorized" });
      }
      await repo.anonymize();
      res.end("ok");
    } catch (error) {
      handleError(error, res);
    }
  }
);

// delete a repository
router.delete(
  "/:repoId/",
  async (req: express.Request, res: express.Response) => {
    const repo = await getRepo(req, res, { nocheck: false });
    if (!repo) return;
    try {
      const user = await getUser(req);
      if (repo.owner.id != user.id) {
        return res.status(401).json({ error: "not_authorized" });
      }
      await repo.remove();
      console.log(`${req.params.repoId} is removed`);
      return res.json("ok");
    } catch (error) {
      handleError(error, res);
    }
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
    try {
      const user = await getUser(req);

      const repo = await getRepositoryFromGitHub({
        owner: req.params.owner,
        repo: req.params.repo,
        accessToken: user.accessToken,
      });
      if (!repo) return res.status(404).send({ error: "repo_not_found" });
      return res.send(
        await repo.readme({
          accessToken: user.accessToken,
          force: req.query.force == "1",
          branch: req.query.branch as string,
        })
      );
    } catch (error) {
      handleError(error, res);
    }
  }
);

// get repository information
router.get("/:repoId/", async (req: express.Request, res: express.Response) => {
  try {
    const repo = await getRepo(req, res, { nocheck: true });
    if (!repo) return;

    const user = await getUser(req);
    if (repo.owner.id != user.id) {
      return res.status(401).send({ error: "not_authorized" });
    }
    res.json((await db.getRepository(req.params.repoId)).toJSON());
  } catch (error) {
    handleError(error, res);
  }
});

function validateNewRepo(repoUpdate) {
  const validCharacters = /^[0-9a-zA-Z\-\_]+$/;
  if (
    !repoUpdate.repoId.match(validCharacters) ||
    repoUpdate.repoId.length < 3
  ) {
    throw new AnonymousError("invalid_repoId");
  }
  if (!repoUpdate.source.branch) {
    throw new AnonymousError("branch_not_specified");
  }
  if (!repoUpdate.source.commit) {
    throw new AnonymousError("commit_not_specified");
  }
  if (!repoUpdate.options) {
    throw new AnonymousError("options_not_provided");
  }
  if (!Array.isArray(repoUpdate.terms)) {
    throw new AnonymousError("invalid_terms_format");
  }
  if (!/^[a-f0-9]+$/.test(repoUpdate.source.commit)) {
    throw new AnonymousError("invalid_commit_format");
  }
}

function updateRepoModel(
  model: IAnonymizedRepositoryDocument,
  repoUpdate: any
) {
  if (repoUpdate.source.type) {
    model.source.type = repoUpdate.source.type;
    if (
      model.source.type != "GitHubStream" &&
      model.source.type != "GitHubDownload"
    ) {
      model.source.type = "GitHubStream";
    }
  }
  model.source.commit = repoUpdate.source.commit;
  model.source.branch = repoUpdate.source.branch;
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
    try {
      const repo = await getRepo(req, res, { nocheck: true });
      if (!repo) return;
      const user = await getUser(req);

      if (repo.owner.id != user.id) {
        return res.status(401).json({ error: "not_authorized" });
      }

      const repoUpdate = req.body;

      validateNewRepo(repoUpdate);

      if (repoUpdate.source.commit != repo.model.source.commit) {
        repo.model.anonymizeDate = new Date();
        repo.model.source.commit = repoUpdate.source.commit;
        await repo.remove();
      }

      updateRepoModel(repo.model, repoUpdate);

      async function removeRepoFromConference(conferenceID) {
        const conf = await ConferenceModel.findOne({
          conferenceID,
        });
        if (conf) {
          const r = conf.repositories.filter((r) => r.id == repo.model.id);
          if (r.length == 1) r[0].removeDate = new Date();
          await conf.save();
        }
      }
      if (!repoUpdate.conference) {
        // remove conference
        if (repo.model.conference) {
          await removeRepoFromConference(repo.model.conference);
        }
      } else if (repoUpdate.conference != repo.model.conference) {
        // update/add conference
        const conf = await ConferenceModel.findOne({
          conferenceID: repoUpdate.conference,
        });
        if (conf) {
          if (
            new Date() < conf.startDate ||
            new Date() > conf.endDate ||
            conf.status !== "ready"
          ) {
            throw new AnonymousError("conf_not_activated");
          }
          const f = conf.repositories.filter((r) => r.id == repo.model.id);
          if (f.length) {
            // the repository already referenced the conference
            f[0].addDate = new Date();
            f[0].removeDate = null;
          } else {
            conf.repositories.push({
              id: repo.model.id,
              addDate: new Date(),
            });
          }
          if (repo.model.conference) {
            await removeRepoFromConference(repo.model.conference);
          }
          await conf.save();
        }
      }
      repo.model.conference = repoUpdate.conference;
      await repo.updateStatus("preparing");
      res.send("ok");
      new Repository(repo.model).anonymize();
    } catch (error) {
      return handleError(error, res);
    }
  }
);

// add repository
router.post("/", async (req: express.Request, res: express.Response) => {
  const user = await getUser(req);
  const repoUpdate = req.body;

  try {
    validateNewRepo(repoUpdate);

    const r = gh(repoUpdate.fullName);
    const repository = await getRepositoryFromGitHub({
      accessToken: user.accessToken,
      owner: r.owner,
      repo: r.name,
    });

    const repo = new AnonymizedRepositoryModel();
    repo.repoId = repoUpdate.repoId;
    repo.anonymizeDate = new Date();
    repo.owner = user.id;

    updateRepoModel(repo, repoUpdate);
    repo.source.accessToken = user.accessToken;
    repo.source.repositoryId = repository.model.id;
    repo.source.repositoryName = repoUpdate.fullName;

    if (repo.source.type == "GitHubDownload") {
      // details.size is in kilobytes
      if (repository.size > config.MAX_REPO_SIZE) {
        return res.status(500).send({ error: "invalid_mode" });
      }
    }
    repo.conference = repoUpdate.conference;

    await repo.save();

    if (repoUpdate.conference) {
      const conf = await ConferenceModel.findOne({
        conferenceID: repoUpdate.conference,
      });
      if (conf) {
        if (
          new Date() < conf.startDate ||
          new Date() > conf.endDate ||
          conf.status !== "ready"
        ) {
          await repo.remove();
          throw new AnonymousError("conf_not_activated");
        }
        conf.repositories.push({
          id: repo.id,
          addDate: new Date(),
        });
        await conf.save();
      }
    }

    res.send("ok");
    new Repository(repo).anonymize();
  } catch (error) {
    if (error.message?.indexOf(" duplicate key") > -1) {
      return handleError(new AnonymousError("repoId_already_used", repoUpdate.repoId), res);
    }
    return handleError(error, res);
  }
});

export default router;
