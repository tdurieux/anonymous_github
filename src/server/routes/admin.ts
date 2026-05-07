import * as os from "os";
import { execSync } from "child_process";
import { Queue, JobType } from "bullmq";
import * as express from "express";
import AnonymousError from "../../core/AnonymousError";
import AnonymizedRepositoryModel from "../../core/model/anonymizedRepositories/anonymizedRepositories.model";
import ConferenceModel from "../../core/model/conference/conferences.model";
import UserModel from "../../core/model/users/users.model";
import { cacheQueue, downloadQueue, removeQueue } from "../../queue";
import { queryMetrics } from "../../queue/queueMetrics";
import User from "../../core/User";
import { ensureAuthenticated } from "./connection";
import { handleError, getUser, isOwnerOrAdmin, getRepo } from "./route-utils";
import adminTokensRouter from "./admin-tokens";
import { octokit, getToken } from "../../core/GitHubUtils";
import {
  createLogger,
  serializeError,
  ERROR_LOG_KEY,
  ERROR_LOG_MAX,
  ERROR_LOG_HOURLY_PREFIX,
  ERROR_LOG_DROPPED_KEY,
  getInProcessDropped,
} from "../../core/logger";
import { createClient, RedisClientType } from "redis";
import config from "../../config";

const logger = createLogger("admin");

let errorLogClient: RedisClientType | null = null;
async function getErrorLogClient(): Promise<RedisClientType | null> {
  if (errorLogClient && errorLogClient.isOpen) return errorLogClient;
  try {
    errorLogClient = createClient({
      socket: {
        host: config.REDIS_HOSTNAME,
        port: config.REDIS_PORT,
      },
    }) as RedisClientType;
    errorLogClient.on("error", () => undefined);
    await errorLogClient.connect();
    return errorLogClient;
  } catch (err) {
    logger.error("error log redis connect failed", serializeError(err));
    return null;
  }
}

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
] as JobType[];

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
  try {
    const job = await queue.getJob(req.params.repo_id);
    if (!job) {
      return res.status(404).json({ error: "job_not_found" });
    }
    const state = await job.getState();
    if (state === "active") {
      return res.status(409).json({ error: "job_is_active", message: "Cannot retry an active job — wait for it to finish or remove it first." });
    }
    try {
      await job.retry();
    } catch {
      const { name, data, opts } = job;
      await job.remove().catch(() => {});
      await queue.add(name, data, opts);
    }
    res.json({ ok: true });
  } catch (error) {
    handleError(error, res, req);
  }
});

router.delete("/queue/:name/:repo_id", async (req, res) => {
  const queue = pickQueue(req.params.name);
  if (!queue) return res.status(404).json({ error: "queue_not_found" });
  try {
    const jobId = req.params.repo_id;
    const job = await queue.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: "job_not_found" });
    }

    const state = await job.getState();

    if (state === "active") {
      // Active jobs hold a worker lock — delete it so remove() succeeds
      const client = await (queue as any).client;
      const lockKey = queue.toKey(jobId) + ":lock";
      await client.del(lockKey);
      logger.info("cleared lock for active job", { queue: queue.name, jobId });
    }

    await job.remove();
    res.json({ ok: true });
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

router.post("/queue/:name/pause", async (req, res) => {
  const queue = pickQueue(req.params.name);
  if (!queue) return res.status(404).json({ error: "queue_not_found" });
  try {
    await queue.pause();
    res.json({ ok: true });
  } catch (error) {
    handleError(error, res, req);
  }
});

router.post("/queue/:name/resume", async (req, res) => {
  const queue = pickQueue(req.params.name);
  if (!queue) return res.status(404).json({ error: "queue_not_found" });
  try {
    await queue.resume();
    res.json({ ok: true });
  } catch (error) {
    handleError(error, res, req);
  }
});

router.post("/queue/:name/empty", async (req, res) => {
  const queue = pickQueue(req.params.name);
  if (!queue) return res.status(404).json({ error: "queue_not_found" });
  try {
    await queue.obliterate({ force: true });
    res.json({ ok: true });
  } catch (error) {
    handleError(error, res, req);
  }
});

router.post("/queues/pause-all", async (_req, res) => {
  try {
    await Promise.all([downloadQueue.pause(), removeQueue.pause(), cacheQueue.pause()]);
    res.json({ ok: true });
  } catch (error) {
    handleError(error, res, _req);
  }
});

async function queueStats(queueKey: string, queue: Queue) {
  const [counts, workers, paused, metrics24h] =
    await Promise.all([
      queue.getJobCounts(...QUEUE_STATES),
      queue.getWorkers().catch(() => []),
      queue.isPaused().catch(() => false),
      queryMetrics(queueKey, 1440),
    ]);

  const workerCount = workers.length;
  const concurrency = workerCount > 0 ? (workers as any)[0]?.opts?.concurrency ?? null : null;

  let completed24h = 0;
  let failed24h = 0;
  for (const p of metrics24h) {
    completed24h += p.completed;
    failed24h += p.failed;
  }

  return {
    counts,
    paused,
    workers: workerCount,
    concurrency,
    completed24h,
    failed24h,
  };
}

const RANGE_MINUTES: Record<string, number> = {
  "1h": 60,
  "6h": 360,
  "24h": 1440,
  "7d": 10080,
};

router.get("/queues/metrics", async (req, res) => {
  const queueName = String(req.query.queue || "download");
  if (!pickQueue(queueName)) return res.status(404).json({ error: "queue_not_found" });
  const range = String(req.query.range || "1h");
  const minutes = RANGE_MINUTES[range] || 60;
  try {
    const points = await queryMetrics(queueName, minutes);
    res.json({ queue: queueName, range, points });
  } catch (error) {
    handleError(error, res, req);
  }
});

router.get("/queues", async (req, res) => {
  const search = req.query.search ? String(req.query.search).toLowerCase() : "";
  const queueName = req.query.queue ? String(req.query.queue) : "";

  const allQueues: { key: string; label: string; queue: Queue }[] = [
    { key: "download", label: "Download", queue: downloadQueue },
    { key: "remove", label: "Remove", queue: removeQueue },
    { key: "cache", label: "Cache cleanup", queue: cacheQueue },
  ];

  const statsResults = await Promise.all(
    allQueues.map(async (q) => ({
      key: q.key,
      label: q.label,
      ...(await queueStats(q.key, q.queue)),
    }))
  );

  const target = queueName
    ? allQueues.find((q) => q.key === queueName)
    : allQueues[0];
  const targetQueue = target ? target.queue : downloadQueue;

  const matches = (job: { id?: string | undefined; name?: string }) => {
    if (!search) return true;
    return (
      (job.id || "").toLowerCase().includes(search) ||
      (job.name || "").toLowerCase().includes(search)
    );
  };

  // Fetch all states in parallel, tag each job with its state
  const jobsByState = await Promise.all(
    QUEUE_STATES.map(async (state) => {
      const jobs = await targetQueue.getJobs([state]);
      return jobs.map((j) => {
        const json: Record<string, unknown> = { ...j.asJSON(), _state: state };
        if (state === "delayed" && j.delay > 0) {
          json.delayUntil = j.timestamp + j.delay;
        }
        return json;
      });
    })
  );
  const allJobs = jobsByState.flat().filter(matches);

  // Sort: active first, then waiting, delayed, failed, completed
  const stateOrder: Record<string, number> = {
    active: 0, waiting: 1, delayed: 2, failed: 3, completed: 4,
  };
  allJobs.sort((a, b) => (stateOrder[a._state as string] ?? 9) - (stateOrder[b._state as string] ?? 9));

  res.json({
    queues: statsResults,
    selectedQueue: target?.key || "download",
    jobs: allJobs,
  });
});

// Errors captured by the logger sink. Server-paginated to avoid pulling
// the full ERROR_LOG_MAX entries on every poll — payloads can be a few KB
// each once detail() enrichment is included.
router.get("/errors", async (req, res) => {
  try {
    const client = await getErrorLogClient();
    if (!client) {
      return res.json({
        entries: [],
        offset: 0,
        limit: 0,
        total: 0,
        max: ERROR_LOG_MAX,
        available: false,
      });
    }
    const offset = Math.max(0, parseInt(String(req.query.offset || "0"), 10) || 0);
    const limit = Math.min(
      ERROR_LOG_MAX,
      Math.max(1, parseInt(String(req.query.limit || "250"), 10) || 250)
    );
    const stop = offset + limit - 1;
    const [raw, total] = await Promise.all([
      client.lRange(ERROR_LOG_KEY, offset, stop),
      client.lLen(ERROR_LOG_KEY),
    ]);
    const entries = raw.map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return { ts: null, module: null, message: s, raw: [] };
      }
    });
    res.json({
      entries,
      offset,
      limit,
      total,
      max: ERROR_LOG_MAX,
      available: true,
    });
  } catch (error) {
    handleError(error, res, req);
  }
});

// Aggregated stats from the precomputed hourly counters (HINCRBY on each
// persistError). No JSON parsing of stored entries — O(48 small HGETALLs).
router.get("/errors/stats", async (req, res) => {
  try {
    const client = await getErrorLogClient();
    if (!client) {
      return res.json({
        available: false,
        last24h: 0,
        prev24h: 0,
        severity: { error: 0, warn: 0, info: 0 },
        unique: { error: 0, warn: 0, info: 0 },
        buckets: [],
        dropped: getInProcessDropped(),
      });
    }
    const now = new Date();
    // Build the 48 hour keys to fetch (24 for current window + 24 for prev).
    function hourKey(d: Date) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      const h = String(d.getUTCHours()).padStart(2, "0");
      return `${ERROR_LOG_HOURLY_PREFIX}${y}${m}${day}${h}`;
    }
    const currentKeys: string[] = [];
    const prevKeys: string[] = [];
    const bucketHourTs: number[] = [];
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 3600 * 1000);
      // Anchor each bar at the end of its hour so a "9s ago" event lands in
      // the rightmost bar.
      const anchor = new Date(
        Date.UTC(
          d.getUTCFullYear(),
          d.getUTCMonth(),
          d.getUTCDate(),
          d.getUTCHours()
        )
      );
      currentKeys.push(hourKey(anchor));
      bucketHourTs.push(anchor.getTime() + 3600 * 1000);
    }
    for (let i = 47; i >= 24; i--) {
      const d = new Date(now.getTime() - i * 3600 * 1000);
      const anchor = new Date(
        Date.UTC(
          d.getUTCFullYear(),
          d.getUTCMonth(),
          d.getUTCDate(),
          d.getUTCHours()
        )
      );
      prevKeys.push(hourKey(anchor));
    }
    const pipe = client.multi();
    for (const k of currentKeys) pipe.hGetAll(k);
    for (const k of prevKeys) pipe.hGetAll(k);
    pipe.get(ERROR_LOG_DROPPED_KEY);
    const results = (await pipe.exec()) as unknown[];
    const currentHashes = results.slice(0, currentKeys.length) as Record<
      string,
      string
    >[];
    const prevHashes = results.slice(
      currentKeys.length,
      currentKeys.length + prevKeys.length
    ) as Record<string, string>[];
    const droppedRedis =
      parseInt(String(results[results.length - 1] || "0"), 10) || 0;

    const buckets: {
      hour: number;
      error: number;
      warn: number;
      info: number;
    }[] = [];
    const sev = { error: 0, warn: 0, info: 0 };
    const uniqueCodes: Record<"error" | "warn" | "info", Set<string>> = {
      error: new Set(),
      warn: new Set(),
      info: new Set(),
    };
    let last24h = 0;
    currentHashes.forEach((h, i) => {
      const flat = h || {};
      const e = parseInt(flat["bucket:error"] || "0", 10) || 0;
      const w = parseInt(flat["bucket:warn"] || "0", 10) || 0;
      const inf = parseInt(flat["bucket:info"] || "0", 10) || 0;
      buckets.push({ hour: bucketHourTs[i], error: e, warn: w, info: inf });
      sev.error += e;
      sev.warn += w;
      sev.info += inf;
      last24h += parseInt(flat.total || "0", 10) || 0;
      // cb:<bucket>:<code> fields → unique code sets.
      for (const k of Object.keys(flat)) {
        if (!k.startsWith("cb:")) continue;
        const sep = k.indexOf(":", 3);
        if (sep < 0) continue;
        const b = k.slice(3, sep) as "error" | "warn" | "info";
        const code = k.slice(sep + 1);
        if (b in uniqueCodes) uniqueCodes[b].add(code);
      }
    });
    let prev24h = 0;
    for (const h of prevHashes) {
      prev24h += parseInt((h || {}).total || "0", 10) || 0;
    }

    res.json({
      available: true,
      last24h,
      prev24h,
      severity: sev,
      unique: {
        error: uniqueCodes.error.size,
        warn: uniqueCodes.warn.size,
        info: uniqueCodes.info.size,
      },
      buckets,
      dropped: droppedRedis + getInProcessDropped(),
    });
  } catch (error) {
    handleError(error, res, req);
  }
});

router.delete("/errors", async (req, res) => {
  try {
    const client = await getErrorLogClient();
    if (!client) return res.json({ ok: true, cleared: 0 });
    const len = await client.lLen(ERROR_LOG_KEY);
    // SCAN the hourly counter keys and del them along with the list and
    // dropped counter so the admin page comes back to a clean slate.
    const hourlyKeys: string[] = [];
    let cursor = 0;
    do {
      const reply = await client.scan(cursor, {
        MATCH: `${ERROR_LOG_HOURLY_PREFIX}*`,
        COUNT: 100,
      });
      cursor = Number(reply.cursor);
      for (const k of reply.keys) hourlyKeys.push(k);
    } while (cursor !== 0);
    const pipe = client.multi();
    pipe.del(ERROR_LOG_KEY);
    pipe.del(ERROR_LOG_DROPPED_KEY);
    if (hourlyKeys.length) pipe.del(hourlyKeys);
    await pipe.exec();
    res.json({ ok: true, cleared: len, hourlyCleared: hourlyKeys.length });
  } catch (error) {
    handleError(error, res, req);
  }
});

// System overview endpoint: process metrics, queue health, DB counts, daily history
router.get("/overview", async (req, res) => {
  try {
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const cpus = os.cpus();
    const cpuCount = cpus.length;

    // Average CPU load (1-min) as percentage
    const loadAvg1m = os.loadavg()[0];
    const cpuPercent = Math.round((loadAvg1m / cpuCount) * 100);

    // Disk usage via df (root partition)
    let diskTotal = 0, diskUsed = 0, diskFree = 0, diskPercent = 0, diskMount = "/";
    try {
      const dfOut = execSync("df -k / 2>/dev/null", { timeout: 3000 }).toString();
      const lines = dfOut.trim().split("\n");
      if (lines.length >= 2) {
        const cols = lines[1].split(/\s+/);
        diskTotal = parseInt(cols[1], 10) * 1024 || 0;
        diskUsed = parseInt(cols[2], 10) * 1024 || 0;
        diskFree = parseInt(cols[3], 10) * 1024 || 0;
        diskPercent = diskTotal ? Math.round((diskUsed / diskTotal) * 100) : 0;
        diskMount = cols[cols.length - 1] || "/";
      }
    } catch {
      // df not available or timed out
    }

    const now24h = new Date(Date.now() - 24 * 3600 * 1000);

    const [
      statusBreakdown,
      totalSize,
      recentErrors,
      totalUsers,
      totalConferences,
      totalRepos,
      activeRepos24h,
      newRepos24h,
      newUsers24h,
      dCounts,
      rCounts,
      cCounts,
    ] = await Promise.all([
      AnonymizedRepositoryModel.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 }, storage: { $sum: "$size.storage" } } },
      ]),
      AnonymizedRepositoryModel.aggregate([
        { $group: { _id: null, total: { $sum: "$size.storage" } } },
      ]),
      AnonymizedRepositoryModel.countDocuments({
        status: "error",
        statusDate: { $gte: now24h },
      }),
      UserModel.estimatedDocumentCount(),
      ConferenceModel.estimatedDocumentCount(),
      AnonymizedRepositoryModel.estimatedDocumentCount(),
      AnonymizedRepositoryModel.countDocuments({
        lastView: { $gte: now24h },
      }),
      AnonymizedRepositoryModel.countDocuments({
        anonymizeDate: { $gte: now24h },
      }),
      UserModel.countDocuments({
        dateOfEntry: { $gte: now24h },
      }),
      downloadQueue.getJobCounts(...QUEUE_STATES),
      removeQueue.getJobCounts(...QUEUE_STATES),
      cacheQueue.getJobCounts(...QUEUE_STATES),
    ]);

    // Error stats (from Redis hourly counters)
    let errorStats = { last24h: 0, severity: { error: 0, warn: 0, info: 0 } };
    try {
      const client = await getErrorLogClient();
      if (client) {
        const nowDate = new Date();
        const keys: string[] = [];
        for (let i = 23; i >= 0; i--) {
          const d = new Date(nowDate.getTime() - i * 3600 * 1000);
          const anchor = new Date(
            Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())
          );
          const y = anchor.getUTCFullYear();
          const m = String(anchor.getUTCMonth() + 1).padStart(2, "0");
          const day = String(anchor.getUTCDate()).padStart(2, "0");
          const h = String(anchor.getUTCHours()).padStart(2, "0");
          keys.push(`${ERROR_LOG_HOURLY_PREFIX}${y}${m}${day}${h}`);
        }
        const pipe = client.multi();
        for (const k of keys) pipe.hGetAll(k);
        const results = (await pipe.exec()) as unknown as Record<string, string>[];
        let total = 0;
        const sev = { error: 0, warn: 0, info: 0 };
        for (const h of results) {
          const flat = h || {};
          total += parseInt(flat.total || "0", 10) || 0;
          sev.error += parseInt(flat["bucket:error"] || "0", 10) || 0;
          sev.warn += parseInt(flat["bucket:warn"] || "0", 10) || 0;
          sev.info += parseInt(flat["bucket:info"] || "0", 10) || 0;
        }
        errorStats = { last24h: total, severity: sev };
      }
    } catch {
      // Redis unavailable — keep defaults
    }

    // Daily history (last 30 days) from DailyStatsModel
    let history: Array<Record<string, unknown>> = [];
    try {
      const { default: DailyStatsModel } = await import(
        "../../core/model/dailyStats/dailyStats.model"
      );
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - 29);
      since.setUTCHours(0, 0, 0, 0);
      const docs = await DailyStatsModel.find({ date: { $gte: since } })
        .sort({ date: 1 })
        .lean();
      history = docs.map((d) => ({
        date: d.date,
        nbRepositories: d.nbRepositories,
        nbUsers: d.nbUsers,
        nbPageViews: d.nbPageViews,
      }));
    } catch {
      // DailyStats collection might not exist yet
    }

    res.json({
      system: {
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        uptime: process.uptime(),
        cpuCount,
        cpuPercent,
        loadAvg: os.loadavg(),
        memTotal: totalMem,
        memFree: freeMem,
        memUsed: totalMem - freeMem,
        memPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
        processRss: mem.rss,
        processHeapUsed: mem.heapUsed,
        processHeapTotal: mem.heapTotal,
        diskTotal,
        diskUsed,
        diskFree,
        diskPercent,
        diskMount,
      },
      repos: {
        total: totalRepos,
        statusBreakdown,
        totalStorage: totalSize[0]?.total || 0,
        recentErrors24h: recentErrors,
        activeRepos24h,
        newRepos24h,
      },
      users: {
        total: totalUsers,
        newUsers24h,
      },
      conferences: {
        total: totalConferences,
      },
      queues: {
        download: dCounts,
        remove: rCounts,
        cache: cCounts,
      },
      errors: errorStats,
      history,
    });
  } catch (error) {
    handleError(error, res, req);
  }
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
      await cacheQueue.add(repo.repoId, { repoId: repo.repoId }, { jobId: `repo-${repo.repoId}` });
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
        req.logout((error) =>
          logger.error("logout failed", serializeError(error))
        );
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
        req.logout((error) =>
          logger.error("logout failed", serializeError(error))
        );
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
router.post(
  "/users/:username/ban",
  async (req: express.Request, res: express.Response) => {
    try {
      const user = await UserModel.findOne({ username: req.params.username });
      if (!user) {
        throw new AnonymousError("user_not_found", { httpStatus: 404 });
      }
      await UserModel.updateOne(
        { _id: user._id },
        { $set: { status: "banned" } }
      );
      const repos = await AnonymizedRepositoryModel.find(
        { owner: user._id, status: { $nin: ["removed", "removing"] } },
        { repoId: 1 }
      ).lean();
      let queued = 0;
      for (const repo of repos) {
        try {
          await removeQueue.add(repo.repoId, { repoId: repo.repoId }, { jobId: `repo-${repo.repoId}` });
          queued++;
        } catch {
          // job may already exist in the queue
        }
      }
      res.json({ ok: true, reposQueued: queued });
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

router.post(
  "/users/:username/activate",
  async (req: express.Request, res: express.Response) => {
    try {
      const result = await UserModel.updateOne(
        { username: req.params.username },
        { $set: { status: "active" } }
      );
      if (result.matchedCount === 0) {
        throw new AnonymousError("user_not_found", { httpStatus: 404 });
      }
      res.json({ ok: true });
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

router.post(
  "/users/:username/promote",
  async (req: express.Request, res: express.Response) => {
    try {
      const result = await UserModel.updateOne(
        { username: req.params.username },
        { $set: { isAdmin: true } }
      );
      if (result.matchedCount === 0) {
        throw new AnonymousError("user_not_found", { httpStatus: 404 });
      }
      res.json({ ok: true });
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

router.post(
  "/users/:username/demote",
  async (req: express.Request, res: express.Response) => {
    try {
      const result = await UserModel.updateOne(
        { username: req.params.username },
        { $set: { isAdmin: false } }
      );
      if (result.matchedCount === 0) {
        throw new AnonymousError("user_not_found", { httpStatus: 404 });
      }
      res.json({ ok: true });
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

router.get("/conferences", async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 10, 1000);
  const skipIndex = (page - 1) * limit;

  const ready = req.query.ready == "true";
  const error = req.query.error == "true";
  const preparing = req.query.preparing == "true";
  const expired = req.query.expired == "true";
  const removed = req.query.removed == "true";

  const sort = parseSort(req);
  const query: Record<string, unknown>[] = [];

  if (req.query.search) {
    const escaped = escapeRegex(req.query.search as string);
    const re = { $regex: escaped, $options: "i" };
    query.push({
      $or: [
        { name: re },
        { conferenceID: re },
      ],
    });
  }

  const dateFilter = parseDateRange(req, "startDate");
  if (dateFilter) query.push(dateFilter);

  const status: { status: string }[] = [];
  if (ready) status.push({ status: "ready" });
  if (error) status.push({ status: "error" });
  if (preparing) status.push({ status: "preparing" });
  if (expired) status.push({ status: "expired" });
  if (removed) status.push({ status: "removed" });
  if (status.length > 0) {
    query.push({ $or: status });
  }

  const filter = query.length ? { $and: query } : {};

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
