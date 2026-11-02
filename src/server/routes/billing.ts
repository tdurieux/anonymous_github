import * as express from "express";
import { randomBytes } from "crypto";
import { ensureAuthenticated } from "./connection";
import { getUser, handleError } from "./route-utils";
import config from "../../config";
import { BillingAccount, BillingGrant } from "../../core/billing/models";
import { billingOrigin, billingPlans, requireBilling } from "../../core/billing/config";
import { createCheckout, stripeClient, fulfillCheckout, syncSubscription } from "../../core/billing/stripe";
import { saveBillingDraft, getBillingDraft } from "../../core/billing/drafts";
import { allowance } from "../../core/billing/quotas";

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
const router = express.Router();
router.use(ensureAuthenticated);
router.get("/", async (req, res) => {
  try {
    const user = await getUser(req);
    req.session.billingCSRF ||= randomBytes(32).toString("hex");
    await new Promise<void>((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    const account = await BillingAccount.findById(user.id).lean();
    const grants = await BillingGrant.find({ owner: user.id }).select("planId scope status until cancelAtPeriodEnd revoked").lean();
    const plans = config.BILLING_ENABLED ? await Promise.all(billingPlans().filter(p => p.priceId).map(async p => {
      const price = await displayedPrice(p.priceId);
      return { id: p.id, name: p.name, description: p.description, repositories: p.repositories, storage: p.storage,
        amount: price.unit_amount, currency: price.currency, interval: price.recurring?.interval, intervalCount: price.recurring?.interval_count };
    })) : [];
    res.set("Cache-Control", "no-store").json({ enabled: config.BILLING_ENABLED, csrf: req.session.billingCSRF, plans, checkoutEnabled: config.BILLING_CHECKOUT_ENABLED,
      grants: grants.map(g => ({ planId: g.planId, scope: g.scope, status: g.revoked ? "revoked" : g.status, until: g.until, cancelAtPeriodEnd: g.cancelAtPeriodEnd })),
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
