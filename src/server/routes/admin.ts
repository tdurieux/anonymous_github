import { Queue, JobType } from "bullmq";
import * as express from "express";
import AnonymousError from "../../core/AnonymousError";
import AnonymizedRepositoryModel from "../../core/model/anonymizedRepositories/anonymizedRepositories.model";
import ConferenceModel from "../../core/model/conference/conferences.model";
import UserModel from "../../core/model/users/users.model";
import { cacheQueue, downloadQueue, removeQueue } from "../../queue";
import User from "../../core/User";
import { ensureAuthenticated } from "./connection";
import { handleError, getUser, isOwnerOrAdmin, getRepo } from "./route-utils";
import adminTokensRouter from "./admin-tokens";
import { octokit, getToken } from "../../core/GitHubUtils";

const router = express.Router();

// user needs to be connected for all user API
router.use(ensureAuthenticated);
router.use(
  async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    const user = await getUser(req);
    try {
      // only admins are allowed here
      isOwnerOrAdmin([], user);
      next();
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

router.use("/tokens", adminTokensRouter);

const QUEUE_STATES = [
  "waiting",
  "active",
  "completed",
  "failed",
  "delayed",
] as const;

function pickQueue(name: string): Queue | null {
  if (name === "download") return downloadQueue;
  if (name === "cache") return cacheQueue;
  if (name === "remove") return removeQueue;
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

function parseSort(req: express.Request, fallbackField = "_id"): Record<string, 1 | -1> {
  const direction = req.query.direction === "asc" ? 1 : -1;
  const field = (req.query.sort as string) || fallbackField;
  return { [field]: direction };
}

function parseDateRange(req: express.Request, field: string) {
  const range: Record<string, Date> = {};
  if (req.query.dateFrom) {
    const d = new Date(req.query.dateFrom as string);
    if (!isNaN(d.getTime())) range.$gte = d;
  }
  if (req.query.dateTo) {
    const d = new Date(req.query.dateTo as string);
    if (!isNaN(d.getTime())) range.$lte = d;
  }
  if (Object.keys(range).length === 0) return null;
  return { [field]: range };
}

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function sendCsv(
  res: express.Response,
  filename: string,
  columns: string[],
  rows: Array<Record<string, unknown>>
) {
  const header = columns.join(",");
  const lines = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(","));
  const body = [header, ...lines].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(body);
}

router.post("/queue/:name/:repo_id", async (req, res) => {
  const queue = pickQueue(req.params.name);
  if (!queue) return res.status(404).json({ error: "queue_not_found" });
  let job;
  try {
    job = await queue.getJob(req.params.repo_id);
    if (!job) {
      return res.status(404).json({ error: "job_not_found" });
    }

    await job.retry();
    res.send("ok");
  } catch {
    try {
      if (job) {
        await job.remove();
        queue.add(job.name, job.data, job.opts);
      }
      res.send("ok");
    } catch {
      res.status(500).json({ error: "error_retrying_job" });
    }
  }
});

router.delete("/queue/:name/:repo_id", async (req, res) => {
  const queue = pickQueue(req.params.name);
  if (!queue) return res.status(404).json({ error: "queue_not_found" });
  try {
    const job = await queue.getJob(req.params.repo_id);
    if (!job) {
      return res.status(404).json({ error: "job_not_found" });
    }
    await job.remove();
    res.send("ok");
  } catch (error) {
    handleError(error, res, req);
  }
});

// Bulk retry all failed in a queue
router.post("/queue/:name/retry-failed", async (req, res) => {
  const queue = pickQueue(req.params.name);
  if (!queue) return res.status(404).json({ error: "queue_not_found" });
  try {
    const failed = await queue.getJobs(["failed"]);
    let count = 0;
    for (const j of failed) {
      try {
        await j.retry();
        count++;
      } catch {
        // ignore single job failures
      }
    }
    res.json({ retried: count, total: failed.length });
  } catch (error) {
    handleError(error, res, req);
  }
});

// Bulk drain all waiting/delayed
router.post("/queue/:name/drain", async (req, res) => {
  const queue = pickQueue(req.params.name);
  if (!queue) return res.status(404).json({ error: "queue_not_found" });
  try {
    await queue.drain(true);
    res.json({ ok: true });
  } catch (error) {
    handleError(error, res, req);
  }
});

router.get("/queues", async (req, res) => {
  const search = req.query.search ? String(req.query.search).toLowerCase() : "";
  const stateFilter = req.query.state ? String(req.query.state) : null;
  const states: JobType[] =
    stateFilter && (QUEUE_STATES as readonly string[]).includes(stateFilter)
      ? [stateFilter as JobType]
      : ([...QUEUE_STATES] as JobType[]);

  const [download, remove, cache, dCounts, rCounts, cCounts] = await Promise.all([
    downloadQueue.getJobs(states),
    removeQueue.getJobs(states),
    cacheQueue.getJobs(states),
    downloadQueue.getJobCounts(...QUEUE_STATES),
    removeQueue.getJobCounts(...QUEUE_STATES),
    cacheQueue.getJobCounts(...QUEUE_STATES),
  ]);

  const matches = (job: { id?: string | undefined; name?: string }) => {
    if (!search) return true;
    return (
      (job.id || "").toLowerCase().includes(search) ||
      (job.name || "").toLowerCase().includes(search)
    );
  };

  res.json({
    downloadQueue: download.filter(matches),
    removeQueue: remove.filter(matches),
    cacheQueue: cache.filter(matches),
    counts: {
      download: dCounts,
      remove: rCounts,
      cache: cCounts,
    },
  });
});

// Global stats endpoint: counts by status, total disk, recent failures
router.get("/stats", async (req, res) => {
  try {
    const [statusBreakdown, totalSize, recentErrors, totalUsers, totalConferences] =
      await Promise.all([
        AnonymizedRepositoryModel.aggregate([
          { $group: { _id: "$status", count: { $sum: 1 }, storage: { $sum: "$size.storage" } } },
        ]),
        AnonymizedRepositoryModel.aggregate([
          { $group: { _id: null, total: { $sum: "$size.storage" } } },
        ]),
        AnonymizedRepositoryModel.countDocuments({
          status: "error",
          statusDate: { $gte: new Date(Date.now() - 1000 * 60 * 60 * 24) },
        }),
        UserModel.estimatedDocumentCount(),
        ConferenceModel.estimatedDocumentCount(),
      ]);
    res.json({
      statusBreakdown,
      totalStorage: totalSize[0]?.total || 0,
      recentErrors24h: recentErrors,
      totalUsers,
      totalConferences,
    });
  } catch (error) {
    handleError(error, res, req);
  }
});

router.get("/repos", async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 10, 1000);
  const ready = req.query.ready == "true";
  const error = req.query.error == "true";
  const preparing = req.query.preparing == "true";
  const remove = req.query.removed == "true";
  const expired = req.query.expired == "true";

  const sort = parseSort(req);
  const query: Record<string, unknown>[] = [];

  // multi-field search: repoId, source.repositoryName, statusMessage, conference
  if (req.query.search) {
    const escaped = escapeRegex(req.query.search as string);
    const re = { $regex: escaped, $options: "i" };
    query.push({
      $or: [
        { repoId: re },
        { "source.repositoryName": re },
        { statusMessage: re },
        { conference: re },
      ],
    });
  }

  // filter by owner username
  if (req.query.owner) {
    const ownerUsername = req.query.owner as string;
    const ownerDoc = await UserModel.findOne({ username: ownerUsername }, { _id: 1 });
    if (!ownerDoc) {
      return res.json({ query: { $and: query }, page, total: 0, sort, results: [], statusCounts: [], totalSize: 0 });
    }
    query.push({ owner: ownerDoc._id });
  }

  // filter by conference
  if (req.query.conference) {
    query.push({ conference: req.query.conference });
  }

  // date range filter on anonymizeDate
  const dateFilter = parseDateRange(req, "anonymizeDate");
  if (dateFilter) query.push(dateFilter);

  const status: { status: string }[] = [];
  if (ready) status.push({ status: "ready" });
  if (error) status.push({ status: "error" });
  if (expired) {
    status.push({ status: "expiring" });
    status.push({ status: "expired" });
  }
  if (remove) {
    status.push({ status: "removing" });
    status.push({ status: "removed" });
  }
  if (preparing) {
    status.push({ status: "preparing" });
    status.push({ status: "download" });
  }
  if (status.length > 0) {
    query.push({ $or: status });
  }

  const filter = query.length ? { $and: query } : {};
  const skipIndex = (page - 1) * limit;

  // CSV export branch
  if (req.query.format === "csv") {
    const all = await AnonymizedRepositoryModel.find(filter).sort(sort).limit(50000).lean();
    const rows = all.map((r) => ({
      repoId: r.repoId,
      status: r.status,
      statusMessage: r.statusMessage || "",
      anonymizeDate: r.anonymizeDate ? new Date(r.anonymizeDate).toISOString() : "",
      lastView: r.lastView ? new Date(r.lastView).toISOString() : "",
      pageView: r.pageView || 0,
      sourceRepository: r.source?.repositoryName || "",
      sourceBranch: r.source?.branch || "",
      sourceCommit: r.source?.commit || "",
      conference: r.conference || "",
      storage: r.size?.storage || 0,
      terms: (r.options?.terms || []).length,
    }));
    return sendCsv(
      res,
      `repositories-${new Date().toISOString().slice(0, 10)}.csv`,
      Object.keys(rows[0] || { repoId: 1 }),
      rows
    );
  }

  const [total, results, statusCounts, sizeAgg] = await Promise.all([
    AnonymizedRepositoryModel.find(filter).countDocuments(),
    AnonymizedRepositoryModel.find(filter)
      .skip(skipIndex)
      .sort(sort)
      .limit(limit)
      .exec(),
    AnonymizedRepositoryModel.aggregate([
      { $match: filter },
      { $group: { _id: "$status", count: { $sum: 1 }, storage: { $sum: "$size.storage" } } },
    ]),
    AnonymizedRepositoryModel.aggregate([
      { $match: filter },
      { $group: { _id: null, total: { $sum: "$size.storage" } } },
    ]),
  ]);
  res.json({
    query: filter,
    page,
    total,
    sort,
    results,
    statusCounts,
    totalSize: sizeAgg[0]?.total || 0,
  });
});

// delete a repository
router.delete(
  "/repos/:repoId/",
  async (req: express.Request, res: express.Response) => {
    const repo = await getRepo(req, res, { nocheck: true });
    if (!repo) return;
    try {
      await cacheQueue.add(repo.repoId, { repoId: repo.repoId }, { jobId: repo.repoId });
      return res.json({ status: repo.status });
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

// Live GitHub info for a repository (admin diagnostic)
router.get(
  "/repos/:repoId/github",
  async (req: express.Request, res: express.Response) => {
    try {
      const repo = await getRepo(req, res, { nocheck: true });
      if (!repo) return;

      let token: string | undefined;
      try {
        token = await getToken(repo);
      } catch {
        token = undefined;
      }
      const oct = octokit(token || "");
      const fullName = repo.model.source?.repositoryName || "";
      const [owner, name] = fullName.split("/");
      if (!owner || !name) {
        return res.status(400).json({ error: "invalid_source_repository" });
      }

      const out: Record<string, unknown> = {
        source: { owner, repo: name, branch: repo.model.source?.branch, commit: repo.model.source?.commit },
      };
      try {
        const info = await oct.repos.get({ owner, repo: name });
        out.repository = {
          fullName: info.data.full_name,
          private: info.data.private,
          archived: info.data.archived,
          disabled: info.data.disabled,
          defaultBranch: info.data.default_branch,
          description: info.data.description,
          stargazers: info.data.stargazers_count,
          watchers: info.data.watchers_count,
          forks: info.data.forks_count,
          openIssues: info.data.open_issues_count,
          size: info.data.size,
          language: info.data.language,
          license: info.data.license?.spdx_id,
          createdAt: info.data.created_at,
          updatedAt: info.data.updated_at,
          pushedAt: info.data.pushed_at,
          htmlUrl: info.data.html_url,
          topics: info.data.topics,
        };
      } catch (e) {
        out.repositoryError = (e as Error)?.message || String(e);
      }
      try {
        if (repo.model.source?.branch) {
          const br = await oct.repos.getBranch({ owner, repo: name, branch: repo.model.source.branch });
          out.branch = {
            name: br.data.name,
            protected: br.data.protected,
            commitSha: br.data.commit?.sha,
          };
        }
      } catch (e) {
        out.branchError = (e as Error)?.message || String(e);
      }
      try {
        if (repo.model.source?.commit) {
          const c = await oct.repos.getCommit({ owner, repo: name, ref: repo.model.source.commit });
          out.commit = {
            sha: c.data.sha,
            message: c.data.commit?.message,
            author: c.data.commit?.author,
            committer: c.data.commit?.committer,
            htmlUrl: c.data.html_url,
            stats: c.data.stats,
            filesChanged: c.data.files?.length,
          };
        }
      } catch (e) {
        out.commitError = (e as Error)?.message || String(e);
      }
      try {
        const r = await oct.rateLimit.get();
        out.rateLimit = {
          remaining: r.data.rate.remaining,
          limit: r.data.rate.limit,
          reset: new Date(r.data.rate.reset * 1000).toISOString(),
        };
      } catch {
        // ignore
      }
      res.json(out);
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

router.get("/users", async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 10, 1000);
  const skipIndex = (page - 1) * limit;

  const sort = parseSort(req);
  const filter: Record<string, unknown> = {};
  if (req.query.search) {
    const escaped = escapeRegex(req.query.search as string);
    filter.$or = [
      { username: { $regex: escaped, $options: "i" } },
      { "emails.email": { $regex: escaped, $options: "i" } },
    ];
  }
  if (req.query.status) {
    filter.status = req.query.status;
  }
  if (req.query.role === "admin") {
    filter.isAdmin = true;
  }
  const dateFilter = parseDateRange(req, "dateOfEntry");
  if (dateFilter) Object.assign(filter, dateFilter);

  // CSV export
  if (req.query.format === "csv") {
    const all = await UserModel.find(filter).sort(sort).limit(50000).lean();
    const rows = all.map((u) => ({
      username: u.username,
      email: u.emails?.[0]?.email || "",
      status: u.status,
      isAdmin: !!u.isAdmin,
      repoCount: (u.repositories || []).length,
      dateOfEntry: u.dateOfEntry ? new Date(u.dateOfEntry).toISOString() : "",
    }));
    return sendCsv(
      res,
      `users-${new Date().toISOString().slice(0, 10)}.csv`,
      ["username", "email", "status", "isAdmin", "repoCount", "dateOfEntry"],
      rows
    );
  }

  const [total, results, statusCounts] = await Promise.all([
    UserModel.find(filter).countDocuments(),
    UserModel.aggregate([
      { $match: filter },
      { $sort: sort },
      { $skip: skipIndex },
      { $limit: limit },
      {
        $addFields: {
          repoCount: { $size: { $ifNull: ["$repositories", []] } },
        },
      },
      { $project: { accessTokens: 0, apiTokens: 0 } },
    ]),
    UserModel.aggregate([
      { $match: filter },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  res.json({ query: filter, page, total, sort, results, statusCounts });
});
router.get(
  "/users/:username",
  async (req: express.Request, res: express.Response) => {
    try {
      const model = await UserModel.findOne({
        username: req.params.username,
      }).populate({
        path: "repositories",
        model: "Repository",
        foreignField: "_id",
        localField: "repositories",
      });
      if (!model) {
        req.logout((error) => console.error(error));
        throw new AnonymousError("user_not_found", {
          httpStatus: 404,
        });
      }
      const user = new User(model);
      res.json(user);
    } catch (error) {
      handleError(error, res, req);
    }
  }
);
router.get(
  "/users/:username/repos",
  async (req: express.Request, res: express.Response) => {
    try {
      const model = await UserModel.findOne({ username: req.params.username });
      if (!model) {
        req.logout((error) => console.error(error));
        throw new AnonymousError("user_not_found", {
          httpStatus: 404,
        });
      }
      const user = new User(model);
      const repos = await user.getRepositories();
      res.json(repos);
    } catch (error) {
      handleError(error, res, req);
    }
  }
);
router.get("/conferences", async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 10, 1000);
  const skipIndex = (page - 1) * limit;

  const sort = parseSort(req);
  const filter: Record<string, unknown> = {};
  if (req.query.search) {
    const escaped = escapeRegex(req.query.search as string);
    filter.$or = [
      { name: { $regex: escaped, $options: "i" } },
      { conferenceID: { $regex: escaped, $options: "i" } },
    ];
  }
  if (req.query.status) filter.status = req.query.status;
  const dateFilter = parseDateRange(req, "startDate");
  if (dateFilter) Object.assign(filter, dateFilter);

  if (req.query.format === "csv") {
    const all = await ConferenceModel.find(filter).sort(sort).limit(50000).lean();
    const rows = all.map((c: Record<string, unknown>) => ({
      conferenceID: c.conferenceID,
      name: c.name,
      status: c.status,
      price: c.price || 0,
      repoCount: ((c.repositories as unknown[]) || []).length,
      startDate: c.startDate ? new Date(c.startDate as Date).toISOString() : "",
      endDate: c.endDate ? new Date(c.endDate as Date).toISOString() : "",
    }));
    return sendCsv(
      res,
      `conferences-${new Date().toISOString().slice(0, 10)}.csv`,
      ["conferenceID", "name", "status", "price", "repoCount", "startDate", "endDate"],
      rows
    );
  }

  const [total, results, statusCounts] = await Promise.all([
    ConferenceModel.find(filter).countDocuments(),
    ConferenceModel.find(filter).sort(sort).limit(limit).skip(skipIndex),
    ConferenceModel.aggregate([
      { $match: filter },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);
  res.json({ query: filter, page, total, sort, results, statusCounts });
});

export default router;
