import { Router } from "express";
import { mongo } from "mongoose";
import { EmailHistoryRecord, emailHistoryCollection, ensureEmailHistoryIndexes } from "../../core/email-history";

const router = Router();
export function emailHistoryQuery(query: Record<string, unknown>) {
  const filter: mongo.Filter<EmailHistoryRecord> = {};
  if (query.state) {
    if (typeof query.state !== "string" || !["sending", "accepted", "rejected", "unknown"].includes(String(query.state))) throw new Error("Invalid status");
    filter.state = query.state as EmailHistoryRecord["state"];
  }
  if (query.kind) {
    if (typeof query.kind !== "string" || !["repository-expiration", "owner-access"].includes(String(query.kind))) throw new Error("Invalid email type");
    filter.kind = query.kind as EmailHistoryRecord["kind"];
  }
  if (query.before) {
    if (typeof query.before !== "string" || query.before.length > 200) throw new Error("Invalid cursor");
    const [date, id, extra] = query.before.split("|");
    const time = new Date(date);
    if (extra || !id || !/^[0-9a-f-]{36}$/.test(id) || !Number.isFinite(time.getTime())) throw new Error("Invalid cursor");
    filter.$or = [{ createdAt: { $lt: time } }, { createdAt: time, _id: { $lt: id } }];
  }
  return filter;
}
// Mounted after the shared authentication and administrator checks.
router.get("/", async (req, res) => {
  res.set("Cache-Control", "no-store");
  let filter: mongo.Filter<EmailHistoryRecord>;
  try { filter = emailHistoryQuery(req.query); }
  catch { res.status(400).json({ error: "Invalid email history filters." }); return; }
  try {
    await ensureEmailHistoryIndexes();
    const rows = await emailHistoryCollection().find(filter, { projection: {
      _id: 1, kind: 1, recipient: 1, ownerId: 1, resourceId: 1, resourceKind: 1,
      createdAt: 1, completedAt: 1, state: 1, httpStatus: 1,
    } }).sort({ createdAt: -1, _id: -1 }).limit(51).toArray();
    const entries = rows.slice(0, 50);
    const last = entries.at(-1);
    res.json({ entries, nextCursor: rows.length > 50 && last ? `${last.createdAt.toISOString()}|${last._id}` : null });
  } catch { res.status(503).json({ error: "Email history is unavailable. Try again." }); }
});
export default router;
