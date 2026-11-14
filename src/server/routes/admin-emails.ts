import { Router } from "express";
import { mongo } from "mongoose";
import { EmailHistoryRecord, emailHistoryCollection, ensureEmailHistoryIndexes } from "../../core/email-history";

const router = Router();
const QUERY_TIMEOUT_MS = 5000;
const emptyCounts = () => ({ accepted: 0, rejected: 0, unknown: 0, sending: 0 });
export function emailHistoryPeriod(period: unknown, now = new Date()) {
  if (period !== undefined && (typeof period !== "string" || !["7d", "30d", "90d", "all"].includes(period))) throw new Error("Invalid period");
  const selected = (period || "all") as string;
  const chartDays = selected === "all" ? 30 : parseInt(selected, 10);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - chartDays + 1));
  return { period: selected, chartDays, start };
}
export function emailHistoryQuery(query: Record<string, unknown>, now = new Date()) {
  const filter: mongo.Filter<EmailHistoryRecord> = {};
  if (query.state) {
    if (typeof query.state !== "string" || !["sending", "accepted", "rejected", "unknown"].includes(String(query.state))) throw new Error("Invalid status");
    filter.state = query.state as EmailHistoryRecord["state"];
  }
  if (query.kind) {
    if (typeof query.kind !== "string" || !["repository-expiration", "owner-access"].includes(String(query.kind))) throw new Error("Invalid email type");
    filter.kind = query.kind as EmailHistoryRecord["kind"];
  }
  const period = emailHistoryPeriod(query.period, now);
  if (period.period !== "all") filter.createdAt = { $gte: period.start };
  if (query.search !== undefined) {
    if (typeof query.search !== "string" || query.search.length > 200) throw new Error("Invalid search");
    const search = query.search.trim();
    if (search) filter.$or = [
      { recipient: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } },
      { _id: search }, { ownerId: search }, { resourceId: search },
    ];
  }
  if (query.before) {
    if (typeof query.before !== "string" || query.before.length > 200) throw new Error("Invalid cursor");
    const [date, id, extra] = query.before.split("|");
    const time = new Date(date);
    if (extra || !id || !/^[0-9a-f-]{36}$/.test(id) || !Number.isFinite(time.getTime())) throw new Error("Invalid cursor");
    const cursor = [{ createdAt: { $lt: time } }, { createdAt: time, _id: { $lt: id } }];
    if (filter.$or) filter.$and = [{ $or: cursor }];
    else filter.$or = cursor;
  }
  return filter;
}
export function emailHistorySummary(
  countsRows: Array<{ _id: string; count: number }>,
  dailyRows: Array<{ _id: { date: string; state: string }; count: number }>,
  period: ReturnType<typeof emailHistoryPeriod>,
) {
  const counts = emptyCounts();
  for (const row of countsRows) if (Object.hasOwn(counts, row._id)) counts[row._id as keyof typeof counts] = row.count;
  const series = Array.from({ length: period.chartDays }, (_, index) => ({
    date: new Date(period.start.getTime() + index * 86400000).toISOString().slice(0, 10), ...emptyCounts(),
  }));
  for (const row of dailyRows) {
    const day = series.find(point => point.date === row._id.date);
    if (day && Object.hasOwn(counts, row._id.state)) day[row._id.state as keyof typeof counts] = row.count;
  }
  return { counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0), series, chartDays: period.chartDays, period: period.period };
}
// Mounted after the shared authentication and administrator checks.
router.get("/summary", async (req, res) => {
  res.set("Cache-Control", "no-store");
  let filter: mongo.Filter<EmailHistoryRecord>, period: ReturnType<typeof emailHistoryPeriod>;
  try {
    const now = new Date();
    filter = emailHistoryQuery({ period: req.query.period, search: req.query.search, kind: req.query.kind }, now);
    period = emailHistoryPeriod(req.query.period, now);
  } catch { res.status(400).json({ error: "Invalid email history filters." }); return; }
  try {
    await ensureEmailHistoryIndexes();
    const [result] = await emailHistoryCollection().aggregate([
      { $match: filter },
      { $facet: {
        counts: [{ $group: { _id: "$state", count: { $sum: 1 } } }],
        daily: [
          { $match: { createdAt: { $gte: period.start } } },
          { $group: { _id: { date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } }, state: "$state" }, count: { $sum: 1 } } },
        ],
      } },
    ], { maxTimeMS: QUERY_TIMEOUT_MS }).toArray();
    res.json(emailHistorySummary(result?.counts || [], result?.daily || [], period));
  } catch { res.status(503).json({ error: "Email history summary is unavailable. Try again." }); }
});
router.get("/", async (req, res) => {
  res.set("Cache-Control", "no-store");
  let filter: mongo.Filter<EmailHistoryRecord>;
  try { filter = emailHistoryQuery(req.query); }
  catch { res.status(400).json({ error: "Invalid email history filters." }); return; }
  try {
    await ensureEmailHistoryIndexes();
    const rows = await emailHistoryCollection().find(filter, { maxTimeMS: QUERY_TIMEOUT_MS, projection: {
      _id: 1, kind: 1, recipient: 1, ownerId: 1, resourceId: 1, resourceKind: 1,
      createdAt: 1, completedAt: 1, state: 1, httpStatus: 1,
    } }).sort({ createdAt: -1, _id: -1 }).limit(51).toArray();
    const entries = rows.slice(0, 50);
    const last = entries.at(-1);
    res.json({ entries, nextCursor: rows.length > 50 && last ? `${last.createdAt.toISOString()}|${last._id}` : null });
  } catch { res.status(503).json({ error: "Email history is unavailable. Try again." }); }
});
export default router;
