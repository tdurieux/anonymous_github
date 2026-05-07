import * as express from "express";
import config from "../../config";
import got from "got";
import { join } from "path";

import { getRepo, getUser, handleError, isCoauthor } from "./route-utils";
import AnonymousError from "../../core/AnonymousError";
import { downloadQueue } from "../../queue";
import { RepositoryStatus } from "../../core/types";
import User from "../../core/User";
import { streamAnonymizedZip } from "../../core/zipStream";
import FileModel from "../../core/model/files/files.model";
import { createLogger, serializeError } from "../../core/logger";
import gh = require("parse-github-url");

const logger = createLogger("repository-public");

const router = express.Router();

router.get(
  "/:repoId/zip",
  async (req: express.Request, res: express.Response) => {
    try {
      if (!config.ENABLE_DOWNLOAD) {
        throw new AnonymousError("download_not_enabled", {
          httpStatus: 403,
          object: req.params.repoId,
        });
      }
      const repo = await getRepo(req, res);
      if (!repo) return;

      let user: User | undefined = undefined;
      try {
        user = await getUser(req);
      } catch { /* not logged in */ }

      let download = false;
      if (
        (!!config.ENABLE_DOWNLOAD && !!config.STREAMER_ENTRYPOINT) ||
        user?.isAdmin === true
      ) {
        download = true;
      }

      if (!download) {
        throw new AnonymousError("download_not_enabled", {
          httpStatus: 403,
          object: req.params.repoId,
        });
      }

      await repo.countView();

      if (config.STREAMER_ENTRYPOINT) {
        // use the streamer service
        const token = await repo.getToken();
        const anonymizer = repo.generateAnonymizeTransformer("");
        res.attachment(`${repo.repoId}.zip`);
        const reqStream = got
          .stream(join(config.STREAMER_ENTRYPOINT, "api/download"), {
            method: "POST",
            json: {
              token,
              repoFullName: repo.model.source.repositoryName,
              commit: repo.model.source.commit,
              branch: repo.model.source.branch,
              repoId: repo.repoId,
              anonymizerOptions: anonymizer.opt,
              contentOptions: {
                image: repo.options.image,
                pdf: repo.options.pdf,
              },
            },
          })
          .on("error", (err: Error & { response?: { statusCode?: number; body?: unknown } }) => {
            const upstreamStatus = err?.response?.statusCode;
            let upstreamBody: string | undefined;
            let errCode = "zip_not_available";
            let httpStatus = 502;
            if (err?.response?.body != null) {
              try {
                upstreamBody =
                  typeof err.response.body === "string"
                    ? err.response.body
                    : Buffer.isBuffer(err.response.body)
                    ? err.response.body.toString("utf8")
                    : JSON.stringify(err.response.body);
              } catch {
                /* ignore */
              }
              if (upstreamBody) {
                try {
                  const parsed = JSON.parse(upstreamBody);
                  if (parsed && typeof parsed.error === "string") {
                    errCode = parsed.error;
                  }
                } catch {
                  /* not JSON */
                }
              }
            }
            if (typeof upstreamStatus === "number") {
              httpStatus = upstreamStatus >= 500 ? 502 : upstreamStatus;
            }
            logger.warn("streamer zip fetch failed", {
              code: errCode,
              httpStatus,
              repoId: repo.repoId,
              upstreamStatus,
              upstreamBody: upstreamBody?.slice(0, 500),
              url: config.STREAMER_ENTRYPOINT
                ? join(config.STREAMER_ENTRYPOINT, "api/zip")
                : undefined,
              err: serializeError(err),
            });
            handleError(
              new AnonymousError(errCode, {
                url: req.originalUrl,
                httpStatus,
                cause: err,
              }),
              res
            );
          });
        reqStream.pipe(res);
        res.on("close", () => {
          reqStream.destroy();
        });
        res.on("error", () => {
          reqStream.destroy();
        });
        return;
      }

      res.attachment(`${repo.repoId}.zip`);
      // cache the file for 6 hours
      res.header("Cache-Control", "max-age=21600");

      const parsed = gh(repo.model.source.repositoryName || "");
      if (!parsed?.owner || !parsed?.name) {
        throw new AnonymousError("repo_not_found", {
          httpStatus: 404,
          object: repo.model.source.repositoryName,
        });
      }
      const anonymizer = repo.generateAnonymizeTransformer("");
      await streamAnonymizedZip(
        {
          repoId: repo.repoId,
          organization: parsed.owner,
          repoName: parsed.name,
          commit: repo.model.source.commit || "HEAD",
          getToken: () => repo.getToken(),
          anonymizerOptions: anonymizer.opt,
          contentOptions: {
            image: repo.options.image,
            pdf: repo.options.pdf,
          },
        },
        res
      );
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

router.get(
  "/:repoId/files",
  async (req: express.Request, res: express.Response) => {
    res.header("Cache-Control", "no-cache");
    const repo = await getRepo(req, res);
    if (!repo) return;
    try {
      res.json(
        await repo.anonymizedFiles({
          includeSha: false,
          recursive: false,
          path: req.query.path as string,
        })
      );
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

router.get(
  "/:repoId/files/counts",
  async (req: express.Request, res: express.Response) => {
    res.header("Cache-Control", "no-cache");
    const repo = await getRepo(req, res);
    if (!repo) return;
    try {
      const repoId = repo.repoId;
      const results = await FileModel.aggregate([
        { $match: { repoId, size: { $ne: null } } },
        { $project: { path: 1 } },
        { $group: { _id: "$path", count: { $sum: 1 } } },
      ]).exec();

      const directCounts: Record<string, number> = {};
      for (const r of results) {
        directCounts[r._id ?? ""] = r.count;
      }

      const folderCounts: Record<string, number> = {};
      for (const [folder, count] of Object.entries(directCounts)) {
        let p = folder;
        folderCounts[p] = (folderCounts[p] || 0) + count;
        while (p) {
          const idx = p.lastIndexOf("/");
          p = idx >= 0 ? p.substring(0, idx) : "";
          folderCounts[p] = (folderCounts[p] || 0) + count;
          if (!p) break;
        }
      }

      const terms = repo.options?.terms || [];
      if (terms.length > 0) {
        const { anonymizePathCompiled, compileTerms } = await import(
          "../../core/anonymize-utils"
        );
        const compiled = compileTerms(terms);
        const anonymized: Record<string, number> = {};
        for (const [folder, count] of Object.entries(folderCounts)) {
          const anonFolder = anonymizePathCompiled(folder, compiled);
          anonymized[anonFolder] = (anonymized[anonFolder] || 0) + count;
        }
        return res.json(anonymized);
      }

      res.json(folderCounts);
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

router.get(
  "/:repoId/files/search",
  async (req: express.Request, res: express.Response) => {
    res.header("Cache-Control", "no-cache");
    const repo = await getRepo(req, res);
    if (!repo) return;
    try {
      const query = ((req.query.q as string) || "").trim();
      if (!query || query.length < 2) {
        return res.json([]);
      }
      const allFiles = await repo.anonymizedFiles({
        includeSha: false,
        recursive: true,
      });
      const q = query.toLowerCase();

      // Collect folder paths whose name segment matches the query
      const matchingFolders = new Set<string>();
      for (const f of allFiles) {
        const segments = (f.path || "").split("/").filter(Boolean);
        let accumulated = "";
        for (const seg of segments) {
          accumulated = accumulated ? `${accumulated}/${seg}` : seg;
          if (seg.toLowerCase().includes(q)) {
            matchingFolders.add(accumulated);
          }
        }
      }

      const matches = allFiles.filter((f) => {
        // File name matches
        if (f.name?.toLowerCase().includes(q)) return true;
        // File is inside a matching folder
        const fullPath = f.path ? `${f.path}/${f.name}` : f.name;
        let found = false;
        matchingFolders.forEach((folder) => {
          if (fullPath?.startsWith(folder + "/") || fullPath === folder) found = true;
        })
        if (found) return true;
        return false;
      });

      res.json(
        matches.slice(0, 500).map((f) => ({
          name: f.name,
          path: f.path,
          size: f.size,
        }))
      );
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

router.get(
  "/:repoId/options",
  async (req: express.Request, res: express.Response) => {
    try {
      res.header("Cache-Control", "no-cache");
      const repo = await getRepo(req, res, {
        nocheck: true,
      });
      if (!repo) return;

      let user: User | undefined = undefined;
      try {
        user = await getUser(req);
      } catch { /* not logged in */ }
      const canEdit =
        !!user &&
        (user.isAdmin ||
          user.id == repo.model.owner ||
          isCoauthor(repo, user));

      let redirectURL = null;
      if (
        !canEdit &&
        repo.status == RepositoryStatus.EXPIRED &&
        repo.options.expirationMode == "redirect" &&
        repo.model.source.repositoryName
      ) {
        redirectURL = `https://github.com/${repo.model.source.repositoryName}`;
      } else if (!canEdit) {
        if (
          repo.status == RepositoryStatus.EXPIRED ||
          repo.status == RepositoryStatus.EXPIRING ||
          repo.status == RepositoryStatus.REMOVING ||
          repo.status == RepositoryStatus.REMOVED
        ) {
          throw new AnonymousError("repository_expired", {
            object: repo,
            httpStatus: 410,
          });
        }

        const fiveMinuteAgo = new Date();
        fiveMinuteAgo.setMinutes(fiveMinuteAgo.getMinutes() - 5);
        if (repo.status != "ready") {
          if (
            repo.status != RepositoryStatus.QUEUE &&
            repo.model.statusDate < fiveMinuteAgo
          ) {
            await repo.updateStatus(RepositoryStatus.PREPARING);
            await downloadQueue.add(repo.repoId, { repoId: repo.repoId }, {
              jobId: `repo-${repo.repoId}`,
              attempts: 3,
            });
          }
          if (repo.status == "error") {
            throw new AnonymousError(
              repo.model.statusMessage
                ? repo.model.statusMessage
                : "repository_not_accessible",
              {
                object: repo,
                httpStatus: 500,
              }
            );
          }
          const rlMatch = (repo.model.statusMessage || "").match(/^rate_limited:(\d+)$/);
          if (rlMatch) {
            const resetAt = parseInt(rlMatch[1], 10);
            throw new AnonymousError("rate_limited", {
              httpStatus: 425,
              object: { resetAt },
            });
          }
          throw new AnonymousError("repository_not_ready", {
            httpStatus: 425,
            object: repo,
          });
        }

        await repo.updateIfNeeded();
      }

      let download = false;
      if (!!config.ENABLE_DOWNLOAD && !!config.STREAMER_ENTRYPOINT) {
        download = true;
      }
      res.json({
        url: redirectURL,
        download: download || user?.isAdmin === true,
        lastUpdateDate: repo.model.source.commitDate
          ? repo.model.source.commitDate
          : repo.model.anonymizeDate,
        isAdmin: user?.isAdmin === true,
        isOwner: user?.id == repo.model.owner,
        hasWebsite: !!repo.options.page && !!repo.options.pageSource,
        truncatedFolders: repo.model.truncatedFolders || [],
      });
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

export default router;
