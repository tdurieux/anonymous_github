import Repository from "../../core/Repository";
import { sourceStorageSize } from "../../core/source/Source";
import { maximumExpiration, neverExpirationDeadline, validateBillingExpiration } from "../../core/billing/expiration";
import config from "../../config";
import { assertConferenceAdmission, reserveRepository } from "../../core/billing/quotas";
import { resetOwnerAccessAlerts } from "../../core/owner-notifications";
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
import { normalizePreserveFiles } from "../../core/preserve-files";
import { sourceFileList } from "../../core/source-file-list";

const logger = createLogger("route:repo");

const router = express.Router();

// user needs to be connected for all user API
router.use(ensureAuthenticated);

async function enqueueSavedSnapshot(model: IAnonymizedRepositoryDocument) {
  try {
    await downloadQueue.add(model.repoId, { repoId: model.repoId }, {
      jobId: `repo-${model.repoId}`, attempts: 3,
    });
  } catch (error) {
    // Leave a failed enqueue retryable without overwriting a worker or a
    // lifecycle change that happened after this save.
    await AnonymizedRepositoryModel.updateOne({
      _id: model._id, status: RepositoryStatus.PREPARING,
      statusDate: model.statusDate, anonymizeDate: model.anonymizeDate,
      "githubAccess.revision": model.githubAccess?.revision || { $exists: false },
    }, { $set: { status: RepositoryStatus.ERROR, statusDate: new Date(),
      statusMessage: "preparation_interrupted" } }).exec();
    throw error;
  }
}

async function previewToken(req: express.Request) {
  const user = await getUser(req);
  if (typeof req.query.anonymizedRepoId === "string") {
    const resource = await db.getRepository(req.query.anonymizedRepoId);
    isOwnerCoauthorOrAdmin(resource, user);
    if (resource.model.source.repositoryName?.toLowerCase() !== `${req.params.owner}/${req.params.repo}`.toLowerCase()) throw appError("repo_not_found", 404);
    if (req.query.reconnect === "1") {
      if (user.id !== resource.owner.id) throw appError("not_owner", 403);
      resource.assertNotArchived();
      return (await selectRepositoryAccess(user.id, resource.model.source.repositoryName,
        resource.model.githubAccess?.kind || "oauth")).token;
    }
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
      { $set: { owner: user.model.id, githubAccess: selectedAccess.binding, accessAlertGeneration: randomUUID() },
        $unset: { accessAlertClaimedAt: "" } }
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

      const user = await getUser(req);
      isOwnerCoauthorOrAdmin(repo, user);

      if (
        repo.status == RepositoryStatus.PREPARING ||
        repo.status == RepositoryStatus.QUEUE ||
        (repo.status == RepositoryStatus.DOWNLOAD &&
          repo.statusActivityDate > new Date(Date.now() - 5 * 60_000)) ||
        repo.status == RepositoryStatus.REMOVING ||
        repo.status == RepositoryStatus.EXPIRING
      ) {
        throw new AnonymousError("invalid_status", { httpStatus: 409 });
      }

      if (user.id === repo.owner.id) await resetOwnerAccessAlerts(user.id, { kind: "repository", id: String(repo.model._id) });
      await repo.refresh();
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

      const maximum = await maximumExpiration(String(repo.model.owner), repo.repoId, repo.model.conference);
      let newExpiration = extendExpirationDate(
        repo.model.options.expirationDate
      );
      // Extend as far as the repository's limit allows, never shortening it.
      if (config.BILLING_ENABLED && newExpiration > maximum) {
        const current = repo.model.options.expirationDate && new Date(repo.model.options.expirationDate);
        if (current && current >= maximum) throw new AnonymousError("expiration_limit_reached", { httpStatus: 402 });
        newExpiration = maximum;
      }
      validateBillingExpiration({ ...repo.model.options, expirationDate: newExpiration }, maximum);
      const reactivating = repo.status === RepositoryStatus.EXPIRED;
      if (reactivating) await assertConferenceAdmission(String(repo.model.owner), repo.repoId, repo.model.conference);
      const updates: Record<string, Date | string | null> = {
        "options.expirationDate": newExpiration,
        settingsSavedAt: new Date(),
      };
      repo.model.options.expirationDate = newExpiration;
      repo.model.settingsSavedAt = updates.settingsSavedAt as Date;
      if (reactivating) {
        repo.model.anonymizeDate = new Date();
        updates.anonymizeDate = repo.model.anonymizeDate;
        updates.status = RepositoryStatus.PREPARING;
        updates.statusDate = new Date();
        updates.statusMessage = null;
      }
      const saved = await AnonymizedRepositoryModel.updateOne(
        { _id: repo.model._id, status: repo.status, statusDate: repo.model.statusDate },
        { $set: updates }
      ).exec();
      if (saved && saved.matchedCount === 0) throw new AnonymousError("invalid_status", { httpStatus: 409 });
      if (user.id === repo.owner.id) await resetOwnerAccessAlerts(user.id, { kind: "repository", id: String(repo.model._id) });

      if (reactivating) {
        // Expiration removes the cached files. Rebuild the saved commit
        // directly instead of asking GitHub for the latest branch head first;
        // that lookup can fail after the new date has already been persisted
        // and leave the repository stuck in the expired state.
        repo.model.status = RepositoryStatus.PREPARING;
        repo.model.statusDate = updates.statusDate as Date;
        repo.model.statusMessage = undefined;
        await enqueueSavedSnapshot(repo.model);
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
        repositoryID: req.query.reconnect === "1" ? undefined : req.query.repositoryID as string,
        force: req.query.reconnect === "1" || req.query.force == "1",
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
        repositoryID: req.query.reconnect === "1" ? undefined : req.query.repositoryID as string,
        force: req.query.reconnect === "1" || req.query.force == "1",
      });
      return res.json(
        await repository.branches({
          accessToken: token,
          force: req.query.reconnect === "1" || req.query.force == "1",
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
        repositoryID: req.query.reconnect === "1" ? undefined : req.query.repositoryID as string,
        force: req.query.reconnect === "1" || req.query.force == "1",
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
          force: req.query.reconnect === "1" || req.query.force == "1",
          branch: req.query.branch as string,
        })
      );
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

// Text files of a source commit, for the "Leave files unredacted" picker (#941).
router.get(
  "/:owner/:repo/tree",
  async (req, res) => {
    try {
      const commit = typeof req.query.commit === "string" ? req.query.commit : "";
      if (!/^[0-9a-f]{6,40}$/i.test(commit)) throw appError("invalid_commit_format", 400);
      const token = await previewToken(req);
      res.set("Cache-Control", "private, no-store");
      res.json(await sourceFileList({
        owner: req.params.owner,
        repo: req.params.repo,
        commit,
        accessToken: token,
      }));
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
  const preserveFiles = normalizePreserveFiles(repoUpdate.options.preserveFiles);
  if (preserveFiles === null) {
    throw new AnonymousError("invalid_preserve_files_format", {
      object: repoUpdate,
      httpStatus: 400,
    });
  }
  repoUpdate.options.preserveFiles = preserveFiles;
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
    preserveFiles: normalizePreserveFiles(repoUpdate.options.preserveFiles) || [],
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
    let recoverReactivation: (() => Promise<void>) | undefined;
    try {
      const repo = await getRepo(req, res, {
        nocheck: true,
      });
      if (!repo) return;
      const user = await getUser(req);

      isOwnerCoauthorOrAdmin(repo, user);

      const repoUpdate = req.body;

      if (repo.status === RepositoryStatus.EXPIRING || repo.status === RepositoryStatus.REMOVING) {
        throw appError("invalid_status", 409);
      }

      validateNewRepo(repoUpdate);

      // Only the source repository/commit/branch backs the cached FileModel —
      // anonymization options (terms, image/link toggles, etc.) are applied on
      // the fly per request. Re-running the download queue is therefore only
      // needed when the underlying snapshot moves. Other edits (e.g. turning
      // off auto-update — see #360) just persist and return.
      const reconnecting = repoUpdate.reconnectRepositoryId !== undefined;
      if (reconnecting) {
        if (user.id !== repo.owner.id) throw appError("not_owner", 403);
        if (typeof repoUpdate.reconnectRepositoryId !== "string" ||
          !/^gh_[1-9][0-9]*$/.test(repoUpdate.reconnectRepositoryId) ||
          repoUpdate.fullName !== repo.model.source.repositoryName) throw appError("repo_not_found", 400);
        if (repo.status && [RepositoryStatus.PREPARING, RepositoryStatus.DOWNLOAD, RepositoryStatus.REMOVING,
          RepositoryStatus.EXPIRING, RepositoryStatus.QUEUE].includes(repo.status)) throw appError("invalid_status", 409);
        repo.assertNotArchived();
      }
      const sourceChanged = reconnecting || hasRepositorySourceChanged(repo.model, repoUpdate);
      const previousAccessRevision = repo.model.githubAccess?.revision;

      // Keep proposed settings separate until cleanup passes the persisted fences.
      const proposed = new AnonymizedRepositoryModel(repo.model.toObject());
      if (repo.model.billingManaged) validateBillingExpiration(repoUpdate.options,
        await maximumExpiration(String(repo.model.owner), repo.repoId, repoUpdate.conference), repo.model.options.expirationDate);
      if (config.BILLING_ENABLED && repoUpdate.options.expirationMode === "never" &&
          (repo.model.options.expirationMode !== "never" || repo.model.billingNeverExpiresUntil)) {
        proposed.billingNeverExpiresUntil = await neverExpirationDeadline(String(repo.model.owner),
          repo.model.options.expirationMode === "never" ? repo.model.billingNeverExpiresUntil : undefined, repo.repoId);
      } else if (repoUpdate.options.expirationMode !== "never") {
        proposed.billingNeverExpiresUntil = undefined;
      }
      updateRepoModel(proposed, repoUpdate);
      const reactivating = shouldReactivateInactiveRepository(proposed);


      if (reactivating) {
        proposed.anonymizeDate = new Date();
      }

      const needsAdmission = sourceChanged || reactivating || repoUpdate.conference !== repo.model.conference;
      if (needsAdmission) {
        await assertConferenceAdmission(String(repo.model.owner), repo.repoId, repoUpdate.conference);
        if (reactivating && config.BILLING_ENABLED && repo.model.billingManaged) {
          const previousStatus = repo.status;
          const previousStatusDate = repo.model.statusDate;
          const claimedAt = new Date();
          const claim = await AnonymizedRepositoryModel.updateOne({ _id: repo.model._id,
            status: previousStatus, statusDate: previousStatusDate,
          }, { $set: { status: RepositoryStatus.PREPARING, statusDate: claimedAt } }).exec();
          if (!claim.matchedCount) throw appError("invalid_status", 409);
          repo.model.status = RepositoryStatus.PREPARING;
          repo.model.statusDate = claimedAt;
          recoverReactivation = async () => {
            await AnonymizedRepositoryModel.updateOne({ _id: repo.model._id,
              status: RepositoryStatus.PREPARING, statusDate: claimedAt,
            }, { $set: { status: previousStatus, statusDate: previousStatusDate || new Date() } }).exec();
          };
        }
        if (repo.model.billingManaged && !sourceChanged) await reserveRepository(String(repo.model.owner), repo.repoId, repo.model.size?.storage || 0, repoUpdate.conference);
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
        const sourceAccess = !reconnecting && repo.model.githubAccess?.kind === "github-app" && repoUpdate.fullName === repo.model.source.repositoryName
          ? { token: await boundAppToken(repo.owner.id, repo.model.githubAccess, repo.model.source.repositoryName), binding: repo.model.githubAccess }
          : await selectRepositoryAccess(repo.owner.id, `${parsedRepository.owner}/${parsedRepository.name}`, repo.model.githubAccess?.kind || "oauth");
        const repository = await getRepositoryFromGitHub({
          accessToken: sourceAccess.token,
          owner: parsedRepository.owner,
          repo: parsedRepository.name,
          force: reconnecting,
        });
        if (!repository) {
          throw new AnonymousError("repo_not_found", {
            object: req.body,
            httpStatus: 404,
          });
        }
        // Pin the owner's preview to a GitHub identity, even if the name is
        // deleted and recreated again before Save.
        if (reconnecting && (repository.id !== repoUpdate.reconnectRepositoryId ||
          (sourceAccess.binding.kind === "github-app" &&
            repository.id !== `gh_${sourceAccess.binding.repositoryId}`))) throw appError("connection_changed", 409);
        if (reconnecting && !(await repository.branches({ accessToken: sourceAccess.token, force: true }))
          .some(branch => branch.name === repoUpdate.source.branch)) throw appError("branch_not_specified", 400);
        const commit = await repository.getCommitInfo(repoUpdate.source.commit, {
          accessToken: sourceAccess.token,
        });
        if (reconnecting) proposed.source.commitDate = commit.commit.committer?.date
          ? new Date(commit.commit.committer.date) : undefined;
        proposed.githubAccess = { ...sourceAccess.binding, revision: randomUUID() };
        proposed.source.repositoryId = repository.model.id;
        proposed.source.repositoryName =
          repository.fullName || repoUpdate.fullName;
        proposed.anonymizeDate = new Date();
        if (repo.model.billingManaged) {
          const storageBytes = await sourceStorageSize(new Repository(proposed).source);
          await reserveRepository(String(repo.model.owner), repo.repoId, storageBytes, repoUpdate.conference);
        }
        await repo.remove({ accessRevision: previousAccessRevision, replacement: true });
      }
      repo.model.set({ options: proposed.options, source: proposed.source,
        githubAccess: proposed.githubAccess, anonymizeDate: proposed.anonymizeDate,
        billingNeverExpiresUntil: proposed.billingNeverExpiresUntil });

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
      const preparation = sourceChanged || reactivating ? {
        status: RepositoryStatus.PREPARING, statusDate: new Date(), statusMessage: null,
      } : undefined;
      const saved = await AnonymizedRepositoryModel.updateOne(
        { _id: repo.model._id, status: repo.status, statusDate: repo.model.statusDate,
          "githubAccess.revision": previousAccessRevision || { $exists: false } },
        {
          $set: {
            ...(repo.model.billingNeverExpiresUntil ? { billingNeverExpiresUntil: repo.model.billingNeverExpiresUntil } : {}),
            settingsSavedAt: new Date(),
            options: repo.model.options,
            source: repo.model.source,
            githubAccess: repo.model.githubAccess,
            conference: repo.model.conference,
            anonymizeDate: repo.model.anonymizeDate,
            ...preparation,
          },
          ...(!repo.model.billingNeverExpiresUntil ? { $unset: { billingNeverExpiresUntil: 1 } } : {}),
        }
      ).exec();
      if (!saved.matchedCount) throw appError("connection_changed", 409);
      recoverReactivation = undefined;
      if (user.id === repo.owner.id) await resetOwnerAccessAlerts(user.id, { kind: "repository", id: String(repo.model._id) });
      if (!sourceChanged && !reactivating) {
        return res.json({ status: repo.status });
      }

      repo.model.status = preparation!.status;
      repo.model.statusDate = preparation!.statusDate;
      repo.model.statusMessage = undefined;
      await enqueueSavedSnapshot(repo.model);
      res.json({ status: repo.status });
    } catch (error) {
      if (recoverReactivation) await recoverReactivation();
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
    repo.settingsSavedAt = repo.anonymizeDate;
    repo.owner = user.id;
    repo.githubAccess = selectedAccess.binding;

    validateBillingExpiration(repoUpdate.options, await maximumExpiration(user.id, repoUpdate.repoId, repoUpdate.conference));
    if (repoUpdate.options.expirationMode === "never") {
      repo.billingNeverExpiresUntil = await neverExpirationDeadline(user.id, undefined, repoUpdate.repoId);
    }
    updateRepoModel(repo, repoUpdate);
    repo.source.type = "GitHubStream";
    repo.source.repositoryId = repository.model.id;
    repo.source.repositoryName = repoUpdate.fullName;

    repo.conference = repoUpdate.conference;

    await assertConferenceAdmission(user.id, repo.repoId, repo.conference);
    repo.billingManaged = config.BILLING_ENABLED;
    await reserveRepository(user.id, repo.repoId, 0, repo.conference);
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
