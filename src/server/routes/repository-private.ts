import { randomUUID } from "crypto";
import { githubQuotaKey } from "../../core/github-token-context";
import { selectRepositoryAccess, boundAppToken, appError } from "../../core/github-app";
import * as express from "express";
import { ensureAuthenticated } from "./connection";

import * as db from "../database";
import {
  getRepo,
  getUser,
  handleError,
  isOwnerOrAdmin,
  isOwnerCoauthorOrAdmin,
  extendExpirationDate,
} from "./route-utils";
import { getRepositoryFromGitHub } from "../../core/source/GitHubRepository";
import gh = require("parse-github-url");
import AnonymizedRepositoryModel from "../../core/model/anonymizedRepositories/anonymizedRepositories.model";
import { IAnonymizedRepositoryDocument } from "../../core/model/anonymizedRepositories/anonymizedRepositories.types";
import ConferenceModel from "../../core/model/conference/conferences.model";
import AnonymousError from "../../core/AnonymousError";
import { addRemovalJob, downloadQueue } from "../../queue";
import RepositoryModel from "../../core/model/repositories/repositories.model";
import { RepositoryStatus } from "../../core/types";
import { octokit, getRedisGateResetAt, getToken } from "../../core/GitHubUtils";
import { createLogger } from "../../core/logger";

const logger = createLogger("route:repo");

const router = express.Router();

// user needs to be connected for all user API
router.use(ensureAuthenticated);

async function previewToken(req: express.Request) {
  const user = await getUser(req);
  if (typeof req.query.anonymizedRepoId === "string") {
    const resource = await db.getRepository(req.query.anonymizedRepoId);
    isOwnerCoauthorOrAdmin(resource, user);
    if (resource.model.source.repositoryName?.toLowerCase() !== `${req.params.owner}/${req.params.repo}`.toLowerCase()) throw appError("repo_not_found", 404);
    return getToken(resource);
  }
  return (await selectRepositoryAccess(user.id, `${req.params.owner}/${req.params.repo}`, req.query.connection)).token;
}

// claim a repository
router.post("/claim", async (req, res) => {
  try {
    const user = await getUser(req);
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
    if (!r?.owner || !r?.name) {
      throw new AnonymousError("repo_not_found", {
        object: req.body,
        httpStatus: 404,
      });
    }
    const selectedAccess = await selectRepositoryAccess(user.id, `${r.owner}/${r.name}`, req.body.connection);
    const repo = await getRepositoryFromGitHub({
      owner: r.owner,
      repo: r.name,
      repositoryID: req.query.repositoryID as string,
      accessToken: selectedAccess.token,
    });
    if (!repo) {
      throw new AnonymousError("repo_not_found", {
        object: req.body,
        httpStatus: 404,
      });
    }

    const dbRepo = await RepositoryModel.findById(
      repoConfig.model.source.repositoryId
    );

    if (!dbRepo || dbRepo.externalId != repo.id) {
      throw new AnonymousError("repo_not_found", {
        object: req.body,
        httpStatus: 404,
      });
    }

    logger.info("repo claimed", {
      user: user.username,
      repo: r.repository,
    });
    repoConfig.owner = user;

    await AnonymizedRepositoryModel.updateOne(
      { repoId: repoConfig.repoId },
      { $set: { owner: user.model.id, githubAccess: selectedAccess.binding } }
    ).collation({ locale: "en", strength: 2 });
    return res.send("Ok");
  } catch (error) {
    handleError(error, res, req);
  }
});

// refresh repository
router.post(
  "/:repoId/refresh",
  async (req, res) => {
    try {
      const repo = await getRepo(req, res, {
        nocheck: true,
      });
      if (!repo) return;

      if (
        repo.status == "preparing" ||
        repo.status == "removing" ||
        repo.status == "expiring"
      )
        return;

      const user = await getUser(req);
      isOwnerCoauthorOrAdmin(repo, user);
      await repo.updateIfNeeded({ force: true });
      res.json({ status: repo.status });
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

// extend the expiration of a repository (default +6 months) and bring it back
// online if it had expired
router.post(
  "/:repoId/extend",
  async (req, res) => {
    try {
      const repo = await getRepo(req, res, { nocheck: true });
      if (!repo) return;

      if (
        repo.status == RepositoryStatus.PREPARING ||
        repo.status == RepositoryStatus.REMOVING ||
        repo.status == RepositoryStatus.EXPIRING ||
        repo.status == RepositoryStatus.REMOVED
      ) {
        throw new AnonymousError("invalid_status", {
          object: repo,
          httpStatus: 409,
        });
      }

      const user = await getUser(req);
      isOwnerCoauthorOrAdmin(repo, user);

      const newExpiration = extendExpirationDate(
        repo.model.options.expirationDate
      );
      const reactivating = repo.status === RepositoryStatus.EXPIRED;
      const updates: Record<string, Date> = {
        "options.expirationDate": newExpiration,
      };
      repo.model.options.expirationDate = newExpiration;
      if (reactivating) {
        repo.model.anonymizeDate = new Date();
        updates.anonymizeDate = repo.model.anonymizeDate;
      }
      await AnonymizedRepositoryModel.updateOne(
        { _id: repo.model._id },
        { $set: updates }
      ).exec();

      if (reactivating) {
        // Expiration removes the cached files. Rebuild the saved commit
        // directly instead of asking GitHub for the latest branch head first;
        // that lookup can fail after the new date has already been persisted
        // and leave the repository stuck in the expired state.
        await repo.updateStatus(RepositoryStatus.PREPARING);
        await downloadQueue.add(
          repo.repoId,
          { repoId: repo.repoId },
          { jobId: `repo-${repo.repoId}`, attempts: 3 }
        );
      }
      res.json({ status: repo.status, expirationDate: newExpiration });
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

// delete a repository
router.delete(
  "/:repoId/",
  async (req, res) => {
    const repo = await getRepo(req, res, {
      nocheck: true,
    });
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
      await repo.updateStatus(RepositoryStatus.REMOVING);
      // Keep removal intent durable if Redis is unavailable. Recovery can
      // enqueue it later, and public requests must remain blocked meanwhile.
      await addRemovalJob(repo.repoId);
      return res.json({ status: repo.status });
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

router.get(
  "/:owner/:repo/",
  async (req, res) => {
    try {
      const token = await previewToken(req);
      const repo = await getRepositoryFromGitHub({
        owner: req.params.owner,
        repo: req.params.repo,
        accessToken: token,
        repositoryID: req.query.repositoryID as string,
        force: req.query.force == "1",
      });
      res.json(repo.toJSON());
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

router.get(
  "/:owner/:repo/branches",
  async (req, res) => {
    try {
      const token = await previewToken(req);
      const repository = await getRepositoryFromGitHub({
        accessToken: token,
        owner: req.params.owner,
        repo: req.params.repo,
        repositoryID: req.query.repositoryID as string,
        force: req.query.force == "1",
      });
      return res.json(
        await repository.branches({
          accessToken: token,
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
  async (req, res) => {
    try {
      const token = await previewToken(req);

      const repo = await getRepositoryFromGitHub({
        owner: req.params.owner,
        repo: req.params.repo,
        accessToken: token,
        repositoryID: req.query.repositoryID as string,
        force: req.query.force == "1",
      });
      if (!repo) {
        throw new AnonymousError("repo_not_found", {
          object: `${req.params.owner}/${req.params.repo}`,
          httpStatus: 404,
        });
      }
      return res.send(
        await repo.readme({
          accessToken: token,
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
router.get("/:repoId/", async (req, res) => {
  try {
    const repo = await getRepo(req, res, {
      nocheck: true,
    });
    if (!repo) return;

    const user = await getUser(req);
    isOwnerCoauthorOrAdmin(repo, user);
    const fullRepo = await db.getRepository(req.params.repoId);
    const json = fullRepo.toJSON() as Record<string, unknown>;
    json.ownerId = fullRepo.owner.id;
    json.role =
      user.isAdmin && fullRepo.owner.id !== user.model.id
        ? "admin"
        : fullRepo.owner.id === user.model.id
        ? "owner"
        : "coauthor";
    json.connection = fullRepo.model.githubAccess?.kind || "oauth";
    // Connection diagnostics must remain available even when access is revoked.
    let gateResetAt = 0;
    try {
      const repoToken = await getToken(fullRepo);
      gateResetAt = await getRedisGateResetAt(githubQuotaKey(repoToken));
    } catch (error) { json.connectionError = error instanceof Error ? error.message : "github_app_reconnect_required"; }
    if (gateResetAt > 0) {
      json.rateLimitResetAt = gateResetAt;
    }
    res.json(json);
  } catch (error) {
    handleError(error, res, req);
  }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validateNewRepo(repoUpdate: any): void {
  const validCharacters = /^[0-9a-zA-Z\-_]+$/;
  if (
    typeof repoUpdate.repoId !== "string" ||
    !repoUpdate.repoId.match(validCharacters) ||
    repoUpdate.repoId.length < 3
  ) {
    throw new AnonymousError("invalid_repoId", {
      object: repoUpdate,
      httpStatus: 400,
    });
  }
  if (!repoUpdate.source) {
    throw new AnonymousError("source_not_provided", {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  repoUpdate: any
) {
  model.source.type = "GitHubStream";
  model.source.commit = repoUpdate.source.commit;
  model.source.branch = repoUpdate.source.branch;
  model.options = {
    terms: repoUpdate.terms,
    expirationMode: repoUpdate.options.expirationMode,
    expirationDate: repoUpdate.options.expirationDate
      ? new Date(repoUpdate.options.expirationDate)
      : undefined,
    update: repoUpdate.options.update,
    image: repoUpdate.options.image,
    pdf: repoUpdate.options.pdf,
    notebook: repoUpdate.options.notebook,
    link: repoUpdate.options.link,
    page: repoUpdate.options.page,
    pageSource: repoUpdate.options.pageSource,
  };
}

export function hasRepositorySourceChanged(
  model: IAnonymizedRepositoryDocument,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  repoUpdate: any
): boolean {
  return (
    repoUpdate.source.commit != model.source.commit ||
    repoUpdate.source.branch != model.source.branch ||
    repoUpdate.fullName != model.source.repositoryName
  );
}

/**
 * An expired or removed repository has had its cached files removed, so saving
 * a valid future expiration must rebuild it even when its GitHub source is
 * unchanged.
 */
export function shouldReactivateInactiveRepository(
  model: IAnonymizedRepositoryDocument,
  now = new Date()
): boolean {
  if (
    model.status !== RepositoryStatus.EXPIRED &&
    model.status !== RepositoryStatus.REMOVED
  ) {
    return false;
  }
  if (model.options.expirationMode === "never") return true;

  const expirationDate = model.options.expirationDate;
  return (
    !!expirationDate &&
    !isNaN(expirationDate.getTime()) &&
    expirationDate > now
  );
}

// update a repository
router.post(
  "/:repoId/",
  async (req, res) => {
    try {
      const repo = await getRepo(req, res, {
        nocheck: true,
      });
      if (!repo) return;
      const user = await getUser(req);

      isOwnerCoauthorOrAdmin(repo, user);

      const repoUpdate = req.body;

      validateNewRepo(repoUpdate);

      // Only the source repository/commit/branch backs the cached FileModel —
      // anonymization options (terms, image/link toggles, etc.) are applied on
      // the fly per request. Re-running the download queue is therefore only
      // needed when the underlying snapshot moves. Other edits (e.g. turning
      // off auto-update — see #360) just persist and return.
      const sourceChanged = hasRepositorySourceChanged(repo.model, repoUpdate);
      const previousAccessRevision = repo.model.githubAccess?.revision;

      updateRepoModel(repo.model, repoUpdate);
      const reactivating = shouldReactivateInactiveRepository(repo.model);

      if (reactivating) {
        repo.model.anonymizeDate = new Date();
      }

      if (sourceChanged) {
        const parsedRepository = gh(repoUpdate.fullName);
        if (!parsedRepository?.owner || !parsedRepository?.name) {
          throw new AnonymousError("repo_not_found", {
            object: req.body,
            httpStatus: 404,
          });
        }
        if (repoUpdate.fullName !== repo.model.source.repositoryName && user.id !== repo.owner.id) throw appError("not_owner", 403);
        const sourceAccess = repo.model.githubAccess?.kind === "github-app" && repoUpdate.fullName === repo.model.source.repositoryName
          ? { token: await boundAppToken(repo.owner.id, repo.model.githubAccess), binding: repo.model.githubAccess }
          : await selectRepositoryAccess(repo.owner.id, `${parsedRepository.owner}/${parsedRepository.name}`, repo.model.githubAccess?.kind || "oauth");
        const repository = await getRepositoryFromGitHub({
          accessToken: sourceAccess.token,
          owner: parsedRepository.owner,
          repo: parsedRepository.name,
        });
        if (!repository) {
          throw new AnonymousError("repo_not_found", {
            object: req.body,
            httpStatus: 404,
          });
        }
        await repository.getCommitInfo(repoUpdate.source.commit, {
          accessToken: sourceAccess.token,
        });
        repo.model.githubAccess = { ...sourceAccess.binding, revision: randomUUID() };
        repo.model.source.repositoryId = repository.model.id;
        repo.model.source.repositoryName =
          repository.fullName || repoUpdate.fullName;
        repo.model.anonymizeDate = new Date();
        await repo.remove({ accessRevision: previousAccessRevision });
      }

      const removeRepoFromConference = async (conferenceID: string) => {
        const conf = await ConferenceModel.findOne({
          conferenceID,
        });
        if (conf) {
          const r = conf.repositories.filter((r) => r.id == repo.model.id);
          if (r.length == 1) r[0].removeDate = new Date();
          await conf.save();
        }
      };
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
            f[0].removeDate = undefined;
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
      const saved = await AnonymizedRepositoryModel.updateOne(
        { _id: repo.model._id, "githubAccess.revision": previousAccessRevision || { $exists: false } },
        {
          $set: {
            options: repo.model.options,
            source: repo.model.source,
            githubAccess: repo.model.githubAccess,
            conference: repo.model.conference,
            anonymizeDate: repo.model.anonymizeDate,
          },
        }
      ).exec();
      if (!saved.matchedCount) throw appError("connection_changed", 409);
      if (!sourceChanged && !reactivating) {
        return res.json({ status: repo.status });
      }

      await repo.updateStatus(RepositoryStatus.PREPARING);
      res.json({ status: repo.status });
      await downloadQueue.add(
        repo.repoId,
        { repoId: repo.repoId },
        { jobId: `repo-${repo.repoId}` }
      );
    } catch (error) {
      return handleError(error, res, req);
    }
  }
);

// add repository
router.post("/", async (req, res) => {
  const repoUpdate = req.body;
  try {
    const user = await getUser(req);
    try {
      await db.getRepository(repoUpdate.repoId);
      throw new AnonymousError("repoId_already_used", {
        httpStatus: 400,
        object: repoUpdate,
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.message == "repo_not_found") {
        // the repository does not exist yet
      } else {
        throw error;
      }
    }
    validateNewRepo(repoUpdate);

    const r = gh(repoUpdate.fullName);
    if (!r?.owner || !r?.name) {
      throw new AnonymousError("repo_not_found", {
        object: req.body,
        httpStatus: 404,
      });
    }
    const selectedAccess = await selectRepositoryAccess(user.id, `${r.owner}/${r.name}`, repoUpdate.connection);
    const repository = await getRepositoryFromGitHub({
      accessToken: selectedAccess.token,
      owner: r.owner,
      repo: r.name,
    });

    if (!repository) {
      throw new AnonymousError("repo_not_found", {
        object: req.body,
        httpStatus: 404,
      });
    }

    await repository.getCommitInfo(repoUpdate.source.commit, {
      accessToken: selectedAccess.token,
    });

    const repo = new AnonymizedRepositoryModel();
    repo.repoId = repoUpdate.repoId;
    repo.anonymizeDate = new Date();
    repo.owner = user.id;
    repo.githubAccess = selectedAccess.binding;

    updateRepoModel(repo, repoUpdate);
    repo.source.type = "GitHubStream";
    repo.source.repositoryId = repository.model.id;
    repo.source.repositoryName = repoUpdate.fullName;

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
          await repo.deleteOne();
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
    downloadQueue.add(repo.repoId, { repoId: repo.repoId }, {
      jobId: `repo-${repo.repoId}`,
      attempts: 3,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message?.indexOf(" duplicate key") > -1
    ) {
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

// list coauthors
router.get(
  "/:repoId/coauthors",
  async (req, res) => {
    try {
      const repo = await getRepo(req, res, { nocheck: true });
      if (!repo) return;
      const user = await getUser(req);
      isOwnerCoauthorOrAdmin(repo, user);
      res.json(repo.coauthors);
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

// add a coauthor (owner/admin only)
router.post(
  "/:repoId/coauthors",
  async (req, res) => {
    try {
      const repo = await getRepo(req, res, { nocheck: true });
      if (!repo) return;
      const user = await getUser(req);
      isOwnerOrAdmin([repo.owner.id], user);

      const username = (req.body.username || "").trim();
      if (!username) {
        throw new AnonymousError("username_not_defined", {
          object: req.body,
          httpStatus: 400,
        });
      }

      // verify the GitHub user exists and capture identity fields
      const oct = octokit(await user.getAccessToken());
      let ghUser;
      try {
        const r = await oct.users.getByUsername({ username });
        ghUser = r.data;
      } catch {
        throw new AnonymousError("github_user_not_found", {
          object: { username },
          httpStatus: 404,
        });
      }

      if (ghUser.login.toLowerCase() === user.username.toLowerCase()) {
        throw new AnonymousError("cannot_coauthor_self", {
          httpStatus: 400,
        });
      }

      const list = repo.model.coauthors || [];
      if (
        list.some(
          (c) => c.username.toLowerCase() === ghUser.login.toLowerCase()
        )
      ) {
        return res.json(list);
      }
      list.push({
        username: ghUser.login,
        githubId: String(ghUser.id),
        photo: ghUser.avatar_url,
        addedAt: new Date(),
      });
      repo.model.coauthors = list;
      await AnonymizedRepositoryModel.updateOne(
        { _id: repo.model._id },
        { $set: { coauthors: list } }
      ).exec();
      res.json(repo.model.coauthors);
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

// remove a coauthor (owner/admin only, or the coauthor themselves)
router.delete(
  "/:repoId/coauthors/:username",
  async (req, res) => {
    try {
      const repo = await getRepo(req, res, { nocheck: true });
      if (!repo) return;
      const user = await getUser(req);
      const target = req.params.username;
      const isOwner = repo.owner.id === user.model.id;
      const coauthor = (repo.model.coauthors || []).find(
        (c) => c.username.toLowerCase() === target.toLowerCase()
      );
      const isSelf = coauthor?.githubId
        ? coauthor.githubId === user.model.externalIDs?.github
        : !!user.username && user.username.toLowerCase() === target.toLowerCase();
      if (!isOwner && !isSelf && !user.isAdmin) {
        throw new AnonymousError("not_authorized", { httpStatus: 401 });
      }

      repo.model.coauthors = (repo.model.coauthors || []).filter(
        (c) => c.username.toLowerCase() !== target.toLowerCase()
      );
      await AnonymizedRepositoryModel.updateOne(
        { _id: repo.model._id },
        { $set: { coauthors: repo.model.coauthors } }
      ).exec();
      res.json(repo.model.coauthors);
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

export default router;
