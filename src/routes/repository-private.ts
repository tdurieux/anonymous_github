import * as express from "express";
import { ensureAuthenticated } from "./connection";

import * as db from "../database/database";
import { getRepo, getUser, handleError, isOwnerOrAdmin } from "./route-utils";
import { getRepositoryFromGitHub } from "../source/GitHubRepository";
import gh = require("parse-github-url");
import GitHubBase from "../source/GitHubBase";
import AnonymizedRepositoryModel from "../database/anonymizedRepositories/anonymizedRepositories.model";
import config from "../../config";
import { IAnonymizedRepositoryDocument } from "../database/anonymizedRepositories/anonymizedRepositories.types";
import Repository from "../Repository";
import ConferenceModel from "../database/conference/conferences.model";
import AnonymousError from "../AnonymousError";
import { downloadQueue, removeQueue } from "../queue";
import RepositoryModel from "../database/repositories/repositories.model";

const router = express.Router();

// user needs to be connected for all user API
router.use(ensureAuthenticated);

// claim a repository
router.post("/claim", async (req: express.Request, res: express.Response) => {
  const user = await getUser(req);
  try {
    if (!req.body.repoId) {
      throw new AnonymousError("repoId_not_defined", {
        object: req.body,
        httpStatus: 400,
      });
    }
    if (!req.body.repoUrl) {
      throw new AnonymousError("repoUrl_not_defined", {
        object: req.body,
        httpStatus: 400,
      });
    }

    const repoConfig = await db.getRepository(req.body.repoId);
    if (repoConfig == null) {
      throw new AnonymousError("repo_not_found", {
        object: req.body,
        httpStatus: 404,
      });
    }

    const r = gh(req.body.repoUrl);
    const repo = await getRepositoryFromGitHub({
      owner: r.owner,
      repo: r.name,
      accessToken: user.accessToken,
    });
    if (!repo) {
      throw new AnonymousError("repo_not_found", {
        object: req.body,
        httpStatus: 404,
      });
    }

    const dbRepo = await RepositoryModel.findById(
      (repoConfig.source as GitHubBase).githubRepository.id
    );

    if (!dbRepo || dbRepo.externalId != repo.id) {
      throw new AnonymousError("repo_not_found", {
        object: req.body,
        httpStatus: 404,
      });
    }

    console.log(`${user.username} claims ${r.repository}.`);
    repoConfig.owner = user;

    await AnonymizedRepositoryModel.updateOne(
      { repoId: repoConfig.repoId },
      { $set: { owner: user.model.id } }
    );
    return res.send("Ok");
  } catch (error) {
    handleError(error, res, req);
  }
});

// refresh repository
router.post(
  "/:repoId/refresh",
  async (req: express.Request, res: express.Response) => {
    try {
      const repo = await getRepo(req, res, { nocheck: true });
      if (!repo) return;

      if (
        repo.status == "preparing" ||
        repo.status == "removing" ||
        repo.status == "expiring"
      )
        return;

      const user = await getUser(req);
      isOwnerOrAdmin([repo.owner.id], user);
      await repo.updateIfNeeded({ force: true });
      res.json({ status: repo.status });
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

// delete a repository
router.delete(
  "/:repoId/",
  async (req: express.Request, res: express.Response) => {
    const repo = await getRepo(req, res, { nocheck: true });
    if (!repo) return;
    // if (repo.status == "removing") return res.json({ status: repo.status });
    try {
      if (repo.status == "removed")
        throw new AnonymousError("is_removed", {
          object: req.params.repoId,
          httpStatus: 410,
        });
      const user = await getUser(req);
      isOwnerOrAdmin([repo.owner.id], user);
      await repo.updateStatus("removing");
      await removeQueue.add(repo.repoId, repo, { jobId: repo.repoId });
      return res.json({ status: repo.status });
    } catch (error) {
      handleError(error, res, req);
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
      handleError(error, res, req);
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
      handleError(error, res, req);
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
      if (!repo) {
        throw new AnonymousError("repo_not_found", {
          object: req.params.repoId,
          httpStatus: 404,
        });
      }
      return res.send(
        await repo.readme({
          accessToken: user.accessToken,
          force: req.query.force == "1",
          branch: req.query.branch as string,
        })
      );
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

// get repository information
router.get("/:repoId/", async (req: express.Request, res: express.Response) => {
  try {
    const repo = await getRepo(req, res, { nocheck: true });
    if (!repo) return;

    const user = await getUser(req);
    isOwnerOrAdmin([repo.owner.id], user);
    res.json((await db.getRepository(req.params.repoId)).toJSON());
  } catch (error) {
    handleError(error, res, req);
  }
});

function validateNewRepo(repoUpdate): void {
  const validCharacters = /^[0-9a-zA-Z\-\_]+$/;
  if (
    !repoUpdate.repoId.match(validCharacters) ||
    repoUpdate.repoId.length < 3
  ) {
    throw new AnonymousError("invalid_repoId", {
      object: repoUpdate,
      httpStatus: 400,
    });
  }
  if (!repoUpdate.source.branch) {
    throw new AnonymousError("branch_not_specified", {
      object: repoUpdate,
      httpStatus: 400,
    });
  }
  if (!repoUpdate.source.commit) {
    throw new AnonymousError("commit_not_specified", {
      object: repoUpdate,
      httpStatus: 400,
    });
  }
  if (!repoUpdate.options) {
    throw new AnonymousError("options_not_provided", {
      object: repoUpdate,
      httpStatus: 400,
    });
  }
  if (!Array.isArray(repoUpdate.terms)) {
    throw new AnonymousError("invalid_terms_format", {
      object: repoUpdate,
      httpStatus: 400,
    });
  }
  if (!/^[a-fA-F0-9]+$/.test(repoUpdate.source.commit)) {
    throw new AnonymousError("invalid_commit_format", {
      object: repoUpdate,
      httpStatus: 400,
    });
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

      isOwnerOrAdmin([repo.owner.id], user);

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
            throw new AnonymousError("conf_not_activated", {
              object: conf,
              httpStatus: 400,
            });
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
      res.json({ status: repo.status });
      await downloadQueue.add(repo.repoId, repo, { jobId: repo.repoId });
    } catch (error) {
      return handleError(error, res, req);
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
        throw new AnonymousError("invalid_mode", {
          object: repository,
          httpStatus: 400,
        });
      }
    }
    if (repository.size < config.AUTO_DOWNLOAD_REPO_SIZE) {
      repo.source.type = "GitHubDownload";
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
          throw new AnonymousError("conf_not_activated", {
            object: conf,
            httpStatus: 400,
          });
        }
        conf.repositories.push({
          id: repo.id,
          addDate: new Date(),
        });
        await conf.save();
      }
    }

    res.send({ status: repo.status });
    downloadQueue.add(repo.repoId, new Repository(repo), {
      jobId: repo.repoId,
      attempts: 3,
    });
  } catch (error) {
    if (error.message?.indexOf(" duplicate key") > -1) {
      return handleError(
        new AnonymousError("repoId_already_used", {
          httpStatus: 400,
          cause: error,
          object: repoUpdate,
        }),
        res,
        req
      );
    }
    return handleError(error, res, req);
  }
});

export default router;
