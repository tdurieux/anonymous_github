import * as express from "express";
import { createHash, randomBytes } from "crypto";
import { ensureAuthenticated } from "./connection";
import { getUser, handleError } from "./route-utils";
import config from "../../config";
import { BillingAccount, BillingGrant } from "../../core/billing/models";
import { billingOrigin, billingPlans, requireBilling, PACK_PLANS, REPO_NEVER_UNTIL } from "../../core/billing/config";
import { createCheckout, stripeClient, fulfillCheckout, syncSubscription } from "../../core/billing/stripe";
import { saveBillingDraft, getBillingDraft } from "../../core/billing/drafts";
import { allowance, usableGrant } from "../../core/billing/quotas";
import RepositoryModel from "../../core/model/anonymizedRepositories/anonymizedRepositories.model";

import { receiveBillingEvent, billingFailure } from "../../core/billing/events";
import { createLogger } from "../../core/logger";
import { rateLimit } from "express-rate-limit";

declare module "express-session" { interface SessionData { billingCSRF?: string } }
export const billingWebhook = express.Router();
billingWebhook.post("/", express.raw({ type: "application/json", limit: "256kb" }), async (req, res) => {
  if (!config.BILLING_ENABLED) { res.sendStatus(404); return; }
  let event;
  try { event = stripeClient().webhooks.constructEvent(req.body, req.headers["stripe-signature"] as string, config.STRIPE_WEBHOOK_SECRET); }
  catch { res.status(400).json({ error: "invalid_billing_signature" }); return; }
  if (event.account || (typeof event.livemode === "boolean" && event.livemode !== /^(sk|rk)_live_/.test(config.STRIPE_SECRET_KEY))) {
    res.status(400).json({ error: "billing_environment_mismatch" }); return;
  }
  try { await receiveBillingEvent(event); res.json({ received: true }); }
  catch (error) { createLogger("billing").error("billing event storage failed", { eventId: event.id, code: billingFailure(error) }); res.status(500).json({ error: "billing_webhook_failed" }); }
});
const priceCache = new Map<string, { expires: number; value: Awaited<ReturnType<ReturnType<typeof stripeClient>["prices"]["retrieve"]>> }>();
async function displayedPrice(id: string) {
  const cached = priceCache.get(id);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = await stripeClient().prices.retrieve(id);
  priceCache.set(id, { expires: Date.now() + 60_000, value });
  return value;
}
type GrantRow = { _id?: unknown; planId?: string | null; scope?: string | null; status?: string | null; until?: Date | null;
  cancelAtPeriodEnd?: boolean | null; revoked?: boolean | null; revocationReason?: string | null; purchasedAt?: Date | null; priceId?: string | null };
// A readable purchase list: pack parts grouped, internal IDs and the
// year-9999 "no end" sentinel hidden, statuses reduced to a few states.
export async function purchaseHistory(grants: GrantRow[], now = new Date()) {
  const state = (g: GrantRow) => g.revoked ? (g.revocationReason === "dispute" ? "disputed" : "refunded")
    : g.status === "past_due" ? "overdue" : usableGrant(g, now) ? "active" : "ended";
  const until = (g: GrantRow) => g.until && g.until.getTime() < REPO_NEVER_UNTIL.getTime() ? g.until : null;
  const groups = new Map<string, GrantRow[]>();
  for (const grant of grants) {
    const id = String(grant._id);
    const key = /^cs_.+:(repo_slot|author_pass|repo_extend)$/.test(id) && grants.filter(g => String(g._id).startsWith(id.split(":")[0] + ":")).length === PACK_PLANS.length
      ? id.split(":")[0] : id;
    groups.set(key, [...(groups.get(key) || []), grant]);
  }
  const purchases = [];
  for (const [key, rows] of groups) {
    const first = rows[0];
    const pack = rows.length > 1;
    let amount: number | null = null, currency: string | null = null, interval: string | null = null;
    if (first.priceId) {
      try { const price = await displayedPrice(first.priceId); amount = price.unit_amount; currency = price.currency; interval = price.recurring?.interval || null; } catch { /* Price display is optional. */ }
    }
    const [kind, target] = String(first.scope || "").split(/:(.*)/s);
    const states = rows.map(state);
    purchases.push({
      id: createHash("sha256").update(key).digest("hex").slice(0, 12),
      planId: pack ? "repo_pack" : first.planId, recurring: ["author_monthly", "author_annual"].includes(first.planId || ""),
      repoId: kind === "repo" ? target : null, conference: kind === "conference" ? target : null,
      status: states.includes("disputed") ? "disputed" : states.includes("refunded") ? "refunded" : states.includes("overdue") ? "overdue"
        : states.includes("active") ? "active" : "ended",
      until: pack ? null : until(first), purchasedAt: first.purchasedAt || null, cancelAtPeriodEnd: !!first.cancelAtPeriodEnd, amount, currency, interval,
      parts: pack ? rows.map(g => ({ planId: g.planId, until: until(g), status: state(g) })) : [],
    });
  }
  return purchases.sort((a, b) => Number(b.status === "active" || b.status === "overdue") - Number(a.status === "active" || a.status === "overdue")
    || (b.purchasedAt?.getTime() || 0) - (a.purchasedAt?.getTime() || 0));
}
const router = express.Router();
router.use(ensureAuthenticated);
router.get("/", async (req, res) => {
  try {
    const user = await getUser(req);
    req.session.billingCSRF ||= randomBytes(32).toString("hex");
    await new Promise<void>((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    const account = await BillingAccount.findById(user.id).lean();
    const grants = await BillingGrant.find({ owner: user.id }).select("planId scope status until cancelAtPeriodEnd revoked revocationReason purchasedAt priceId").lean();
    const repositories = config.BILLING_ENABLED ? await RepositoryModel.find({ owner: user.id, status: { $ne: "removed" } })
      .select("repoId status options.expirationMode options.expirationDate").sort({ anonymizeDate: -1 }).limit(500).lean() : [];
    const plans = config.BILLING_ENABLED ? await Promise.all(billingPlans().filter(p => p.priceId).map(async p => {
      const price = await displayedPrice(p.priceId);
      return { id: p.id, name: p.name, description: p.description, repositories: p.repositories, storage: p.storage,
        amount: price.unit_amount, currency: price.currency, interval: price.recurring?.interval, intervalCount: price.recurring?.interval_count };
    })) : [];
    res.set("Cache-Control", "no-store").json({ enabled: config.BILLING_ENABLED, csrf: req.session.billingCSRF, plans, checkoutEnabled: config.BILLING_CHECKOUT_ENABLED, freeExpirationMonths: config.FREE_EXPIRATION_MONTHS,
      grants: grants.map(g => ({ planId: g.planId, scope: g.scope, status: g.revoked ? "revoked" : g.status, until: g.until, cancelAtPeriodEnd: g.cancelAtPeriodEnd })),
      purchases: config.BILLING_ENABLED ? await purchaseHistory(grants) : [],
      repositories: repositories.map(r => ({ repoId: r.repoId, status: r.status, expirationMode: r.options?.expirationMode, expirationDate: r.options?.expirationDate })),
      portal: !!account?.customerId, allowance: config.BILLING_ENABLED ? await allowance(user.id) : null });
  } catch (error) { handleError(error, res, req); }
});
router.get("/draft/:id", async (req, res) => {
  try {
    const user = await getUser(req);
    const draft = await getBillingDraft(user.id, req.params.id);
    res.set("Cache-Control", "no-store").json({ id: draft._id, path: draft.path, values: draft.values });
  } catch (error) { handleError(error, res, req); }
});
router.use((req, res, next) => {
  if (!req.session.billingCSRF || req.headers["x-csrf-token"] !== req.session.billingCSRF) { res.status(403).json({ error: "invalid_auth_state" }); return; }
  next();
});
router.use(rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false }));
router.post("/draft", async (req, res) => {
  try {
    requireBilling();
    const user = await getUser(req);
    const draft = await saveBillingDraft(user.id, req.body.path, req.body.values);
    res.set("Cache-Control", "no-store").json({ id: draft._id });
  } catch (error) { handleError(error, res, req); }
});
router.post("/checkout", async (req, res) => {
  try {
    requireBilling();
    const user = await getUser(req);
    if (typeof req.body.planId !== "string" || (req.body.target != null && typeof req.body.target !== "string")) { res.sendStatus(400); return; }
    let returnPath: string | undefined;
    if (req.body.draftId != null) {
      const draft = await getBillingDraft(user.id, req.body.draftId);
      returnPath = `${draft.path}?billingDraft=${draft._id}`;
    }
    res.json({ url: await createCheckout(user.id, req.body.planId, req.body.target, undefined, returnPath) });
  } catch (error) { handleError(error, res, req); }
});
router.post("/portal", async (req, res) => {
  try {
    const user = await getUser(req);
    const account = await BillingAccount.findById(user.id).lean();
    if (!account?.customerId) { res.status(404).json({ error: "billing_customer_not_found" }); return; }
    const portal = await stripeClient().billingPortal.sessions.create({ customer: account.customerId, return_url: `${billingOrigin()}/profile?billing=portal` });
    res.json({ url: portal.url });
  } catch (error) { handleError(error, res, req); }
});
router.post("/refresh", async (req, res) => {
  try {
    requireBilling();
    const user = await getUser(req);
    const account = await BillingAccount.findById(user.id).lean();
    let pending = !!account?.checkout?.key && !account.checkout.id;
    if (account?.checkout?.id) {
      await fulfillCheckout(account.checkout.id);
      const checkout = await stripeClient().checkout.sessions.retrieve(account.checkout.id);
      pending = checkout.status !== "expired" && checkout.payment_status === "unpaid";
    }
    const grants = await BillingGrant.find({ owner: user.id, subscriptionId: { $exists: true } }).lean();
    for (const grant of grants) await syncSubscription(grant.subscriptionId!);
    res.json({ ok: true, pending });
  } catch (error) { handleError(error, res, req); }
});
export default router;
