import * as express from "express";
import { AsyncCache } from "../../core/async-cache";
import { BILLING_PERIODS, billingGrants, billingSummary, billingWebhookHealth } from "../../core/billing/report";
import UserModel from "../../core/model/users/users.model";
import { handleError } from "./route-utils";

// Mounted under the admin router, after its administrator check.
const router = express.Router();
const summaryCache = new AsyncCache<Awaited<ReturnType<typeof billingSummary>>>(30_000, 8);

async function usernames(ids: string[]) {
  const users = await UserModel.find({ _id: { $in: ids.filter(id => /^[a-f0-9]{24}$/.test(id)) } }).select("username").lean();
  return new Map(users.map(u => [String(u._id), u.username as string]));
}

router.get("/summary", async (req, res) => {
  try {
    const period = typeof req.query.period === "string" && req.query.period in BILLING_PERIODS ? req.query.period : "30d";
    const [summary, webhooks] = await Promise.all([summaryCache.get(period, () => billingSummary(period)), billingWebhookHealth()]);
    res.set("Cache-Control", "no-store").json({ ...summary, webhooks });
  } catch (error) { handleError(error, res, req); }
});

router.get("/grants", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store").json(await billingGrants({ ...req.query, owners: null }, usernames));
  } catch (error) { handleError(error, res, req); }
});

export default router;
