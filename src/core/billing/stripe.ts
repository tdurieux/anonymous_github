import Stripe = require("stripe");
import { randomUUID } from "crypto";
import config from "../../config";
import { BillingAccount, BillingGrant, BillingLock, BillingRevocation, BillingPrice } from "./models";
import { billingError, billingOrigin, billingPlans, requireBilling } from "./config";
import ConferenceModel from "../model/conference/conferences.model";
import RepositoryModel from "../model/anonymizedRepositories/anonymizedRepositories.model";

export function stripeClient() { requireBilling(); return new Stripe(config.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 10_000 }); }
const objectId = (value: string | { id: string } | null) => typeof value === "string" ? value : value?.id;
export async function withBillingLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  try { await BillingLock.updateOne({ _id: id, until: { $lt: new Date() } }, { $set: { token, until: new Date(Date.now() + 180_000) } }, { upsert: true }); }
  catch (error) { if ((error as { code?: number }).code === 11000) throw billingError("billing_busy", 409); throw error; }
  const heartbeat = setInterval(() => {
    BillingLock.updateOne({ _id: id, token }, { $set: { until: new Date(Date.now() + 180_000) } }).catch(() => undefined);
  }, 30_000);
  heartbeat.unref();
  try { return await work(); }
  finally { clearInterval(heartbeat); await BillingLock.deleteOne({ _id: id, token }); }
}
export async function syncSubscription(id: string, stripe = stripeClient()) {
  // Compare-and-swap prevents a slow, earlier fetch from overwriting a newer one.
  for (let retry = 0; retry < 4; retry++) {
    const previous = await BillingGrant.findById(id).lean();
    const sub = await stripe.subscriptions.retrieve(id, { expand: ["latest_invoice"] });
    const owner = sub.metadata.owner;
    if (!owner || sub.metadata.application !== "anonymous-github") return;
    const account = await BillingAccount.findById(owner).lean();
    if (!account || account.customerId !== objectId(sub.customer)) throw billingError("billing_customer_mismatch");
    const priceId = sub.items.data[0]?.price.id;
    const plan = billingPlans().find(p => p.recurring && p.priceId === priceId);
    const invoice = sub.latest_invoice as Stripe.Invoice | null;
    const paid = !!plan && sub.items.data.length === 1 && sub.status === "active" && invoice?.status === "paid";
    const periodEnd = sub.items.data[0]?.current_period_end;
    let paidThrough = paid && periodEnd ? new Date(periodEnd * 1000) : previous?.until || new Date(0);
    // A missed paid renewal followed by a failed invoice must be recoverable.
    // Only matching subscription-item service periods count, not arbitrary invoices.
    if (!paid && plan && sub.items.data.length === 1 && stripe.invoices?.list) {
      for await (const historical of stripe.invoices.list({ subscription: id, status: "paid", limit: 100 })) {
        for await (const line of stripe.invoices.listLineItems(historical.id, { limit: 100 })) {
          if (!line.parent?.subscription_item_details?.proration && line.amount >= 0 &&
            line.parent?.subscription_item_details?.subscription_item === sub.items.data[0].id &&
            line.period.end * 1000 > paidThrough.getTime()) paidThrough = new Date(line.period.end * 1000);
        }
      }
    }
    const values = { owner, scope: `user:${owner}`, planId: plan?.id || "unknown", customerId: account.customerId,
      subscriptionId: id, status: sub.status, cancelAtPeriodEnd: sub.cancel_at_period_end || !!sub.cancel_at,
      until: paidThrough,
    };
    if (!previous) {
      try { await BillingGrant.create({ _id: id, ...values }); return; }
      catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    } else {
      const result = await BillingGrant.updateOne({ _id: id, revision: previous.revision }, { $set: values, $inc: { revision: 1 } });
      if (result.matchedCount) return;
    }
  }
  throw billingError("billing_busy", 409);
}
export async function fulfillCheckout(id: string, stripe = stripeClient()) {
  const session = await stripe.checkout.sessions.retrieve(id, { expand: ["line_items", "payment_intent.latest_charge"] });
  if (session.metadata?.application !== "anonymous-github") return;
  const { owner, planId, target } = session.metadata;
  const account = await BillingAccount.findById(owner).lean();
  if (!account || account.customerId !== objectId(session.customer)) throw billingError("billing_customer_mismatch");
  if (session.status !== "complete") return;
  if (session.subscription) { await syncSubscription(objectId(session.subscription)!, stripe); return; }
  const plan = billingPlans().find(p => p.id === planId && !p.recurring);
  const priceId = session.line_items?.data[0]?.price?.id;
  const previousGrant = await BillingGrant.findById(id).lean();
  const historicalPrice = priceId ? await BillingPrice.findById(priceId).lean() : null;
  const previousScope = planId === "conference" ? `conference:${target}` : `repo:${target}`;
  const acceptedGrant = previousGrant?.owner === owner && previousGrant?.customerId === account.customerId
    && previousGrant?.planId === planId && previousGrant?.scope === previousScope
    && (!previousGrant.priceId || previousGrant.priceId === priceId);
  if (!plan || !priceId || session.line_items?.data.length !== 1 || session.line_items.data[0].quantity !== 1 ||
    !(priceId === plan.priceId || historicalPrice?.planId === planId || acceptedGrant)) throw billingError("billing_invalid_purchase");
  await BillingPrice.updateOne({ _id: priceId }, { $setOnInsert: { planId } }, { upsert: true });
  if (session.payment_status !== "paid" || session.status !== "complete") return;
  const intent = session.payment_intent as Stripe.PaymentIntent | null;
  const charge = intent?.latest_charge as Stripe.Charge | null;
  const revoked = !!charge && (charge.refunded || charge.disputed);
  const scope = plan.id === "conference" ? `conference:${target}` : `repo:${target}`;
  let until = new Date(session.created * 1000 + 180 * 86400_000);
  if (plan.id === "conference") {
    const conference = await ConferenceModel.findOne({ conferenceID: target });
    // Historical sessions can outlive a deliberately deleted conference.
    if (!conference) return;
    until = conference.endDate;
  }
  await BillingGrant.updateOne({ _id: id }, { $setOnInsert: { owner, scope, planId, customerId: account.customerId,
    paymentIntentId: objectId(session.payment_intent), priceId, status: "paid", until }, ...(revoked ? { $set: { revoked: true } } : {}) }, { upsert: true });
  const reversal = intent && await BillingRevocation.findById(intent.id).lean();
  if (reversal?.reviewed) await BillingGrant.updateOne({ _id: id }, { $set: { revoked: false } });
  else if (reversal) await BillingGrant.updateOne({ _id: id }, { $set: { revoked: true, revocationReason: reversal.reason } });
  if (plan.id === "conference" && (!revoked || reversal?.reviewed)) {
    const grant = await BillingGrant.findById(id).lean();
    if (!grant?.revoked) await ConferenceModel.updateOne({ conferenceID: target, status: "pending_payment", "plan.planID": "conference" }, { $set: { status: "ready" } });
  }
}
export async function processBillingEvent(event: Stripe.Event, stripe = stripeClient()) {
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    await fulfillCheckout(event.data.object.id, stripe);
  } else if (event.type.startsWith("customer.subscription.")) {
    await syncSubscription((event.data.object as Stripe.Subscription).id, stripe);
  } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const invoice = event.data.object as Stripe.Invoice;
    const id = objectId(invoice.parent?.subscription_details?.subscription || null);
    if (id) await syncSubscription(id, stripe);
  } else if (event.type === "charge.refunded" || event.type === "charge.dispute.created") {
    const charge = event.type === "charge.refunded" ? event.data.object as Stripe.Charge
      : await stripe.charges.retrieve(objectId((event.data.object as Stripe.Dispute).charge)!);
    // Partial goodwill refunds preserve access. Full refunds and disputes revoke.
    if (event.type === "charge.refunded" && charge.refunded === false) return;
    const intent = objectId(charge.payment_intent);
    if (!intent) return;
    const reason = event.type === "charge.dispute.created" || charge.disputed ? "dispute" : "full_refund";
    await BillingRevocation.updateOne({ _id: intent }, { $setOnInsert: { reason } }, { upsert: true });
    // A dispute escalates a reviewed refund. An older refund replay must not
    // undo the operator's review of that dispute.
    if (reason === "dispute") await BillingRevocation.updateOne({ _id: intent, reason: "full_refund" }, { $set: { reason, reviewed: false } });
    const reversal = await BillingRevocation.findById(intent).lean();
    if (reversal?.reviewed) return;
    const revocation = { revoked: true, revocationReason: reason, revokedAt: new Date() };
    await BillingGrant.updateMany({ paymentIntentId: intent }, { $set: revocation, $inc: { revision: 1 } });
    // Resolve the affected subscription, not every subscription owned by this payer.
    let after: string | undefined;
    do {
      const payments = await stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: intent }, limit: 100, ...(after ? { starting_after: after } : {}) });
      for (const payment of payments.data) {
        const invoice = await stripe.invoices.retrieve(objectId(payment.invoice)!);
        const subscriptionId = objectId(invoice.parent?.subscription_details?.subscription || null);
        if (subscriptionId) {
          await BillingRevocation.updateOne({ _id: intent }, { $set: { subscriptionId } });
          await BillingGrant.updateOne({ _id: subscriptionId }, { $set: revocation, $inc: { revision: 1 } }, { upsert: true });
        }
      }
      after = payments.has_more ? payments.data.at(-1)?.id : undefined;
    } while (after);
  }
}
export async function createCheckout(owner: string, planId: string, target = "", stripe = stripeClient(), returnPath?: string) {
  if (!config.BILLING_CHECKOUT_ENABLED) throw billingError("billing_checkout_disabled", 503);
  const plan = billingPlans().find(p => p.id === planId && p.priceId);
  if (!plan) throw billingError("billing_plan_unavailable");
  if (plan.id === "conference") {
    const conf = await ConferenceModel.findOne({ conferenceID: target, owners: owner });
    if (!conf || conf.plan.planID !== "conference" || conf.status !== "pending_payment") throw billingError("billing_invalid_conference");
    if (conf.endDate <= new Date() || conf.endDate.getTime() - conf.startDate.getTime() > 180 * 86400_000) throw billingError("billing_invalid_review_window");
  } else if (plan.id === "author_pass") {
    const repo = await RepositoryModel.exists({ repoId: target, owner, status: { $nin: ["removed", "expired"] } });
    if (!repo) throw billingError("repo_not_found", 404);
  } else target = "";
  const destination = returnPath || (plan.id === "conference" ? `/conference/${encodeURIComponent(target)}` : "/profile");
  if (returnPath && !/^\/anonymize(?:\/[A-Za-z0-9_-]{1,200})?\?billingDraft=[a-f0-9-]{36}$/.test(returnPath)) throw billingError("billing_invalid_draft");
  const outcomeUrl = (outcome: string) => `${billingOrigin()}${destination}${destination.includes("?") ? "&" : "?"}billing=${outcome}`;
  return withBillingLock(`checkout:${owner}`, async () => {
    let account = await BillingAccount.findById(owner);
    if (!account) account = await BillingAccount.create({ _id: owner });
    if (!account.customerId) {
      if (account.customerAttemptAt && Date.now() - account.customerAttemptAt.getTime() >= 23 * 3600_000) {
        // A customer creation timeout must not cause a duplicate after key pruning.
        throw billingError("billing_recovery_required", 409);
      }
      account.customerAttemptAt ||= new Date();
      await account.save();
      const customer = await stripe.customers.create({ metadata: { application: "anonymous-github", owner } }, { idempotencyKey: `customer:${owner}` });
      account.customerId = customer.id;
      await account.save();
    }
    if (account.checkout?.key && !account.checkout.id &&
      (!account.checkout.createdAt || Date.now() - account.checkout.createdAt.getTime() >= 23 * 3600_000)) {
      for await (const candidate of stripe.checkout.sessions.list({ customer: account.customerId, limit: 100 })) {
        if (candidate.metadata?.attempt === account.checkout.key && candidate.metadata.owner === owner) {
          account.checkout.id = candidate.id;
          await account.save();
          break;
        }
      }
      if (!account.checkout.id) {
        // After the provider key window, an expired immutable request can no
        // longer create a session. Legacy attempts without expiry need review.
        if (account.checkout.params?.expires_at && account.checkout.createdAt &&
          Date.now() - account.checkout.createdAt.getTime() > 24 * 3600_000 &&
          account.checkout.params.expires_at * 1000 < Date.now()) {
          account.checkout = undefined;
          await account.save();
        } else throw billingError("billing_recovery_required", 409);
      }
    }
    if (account.checkout?.params?.success_url && !account.checkout.id && account.checkout.params.success_url !== outcomeUrl("success")) throw billingError("billing_checkout_in_progress", 409);
    if (account.checkout?.id) {
      const existing = await stripe.checkout.sessions.retrieve(account.checkout.id);
      if (existing.status === "open") {
        if (account.checkout.planId !== planId || account.checkout.target !== target) throw billingError("billing_checkout_in_progress", 409);
        if (account.checkout.params?.success_url && account.checkout.params.success_url !== outcomeUrl("success")) throw billingError("billing_checkout_in_progress", 409);
        return existing.url;
      }
      if (existing.status === "complete") await fulfillCheckout(existing.id, stripe);
    }
    const price = await stripe.prices.retrieve(plan.priceId);
    const interval = plan.id === "author_monthly" ? "month" : "year";
    if (!price.active || price.currency !== "eur" || price.unit_amount == null || price.unit_amount <= 0 ||
      (plan.recurring ? price.recurring?.interval !== interval || price.recurring?.interval_count !== 1 : !!price.recurring)) throw billingError("billing_price_misconfigured", 503);
    if (plan.recurring) {
      let after: string | undefined;
      do {
        const subscriptions = await stripe.subscriptions.list({ customer: account.customerId, status: "all", limit: 100, ...(after ? { starting_after: after } : {}) });
        if (subscriptions.data.some(s => !["canceled", "incomplete_expired"].includes(s.status))) throw billingError("billing_subscription_exists", 409);
        after = subscriptions.has_more ? subscriptions.data.at(-1)?.id : undefined;
      } while (after);
    } else if (await BillingGrant.exists({ scope: `${plan.id === "conference" ? "conference" : "repo"}:${target}`, revoked: false, until: { $gt: new Date() } })) throw billingError("billing_already_paid", 409);
    // Persist the idempotency key before sending a request. A timeout can safely retry it.
    if (!account.checkout?.key || account.checkout.id) {
      account.checkout = { key: randomUUID(), planId, target, createdAt: new Date(), expiresAt: new Date(Date.now() + 1860_000) };
      await account.save();
    }
    if (account.checkout.planId !== planId || account.checkout.target !== target) throw billingError("billing_checkout_in_progress", 409);
    const metadata = { application: "anonymous-github", owner, planId, target, attempt: account.checkout.key! };
    const params: Stripe.Checkout.SessionCreateParams = { customer: account.customerId, expires_at: Math.floor(Date.now() / 1000) + 1860,
      mode: plan.recurring ? "subscription" : "payment", line_items: [{ price: plan.priceId, quantity: 1 }],
      allowed_payment_method_types: ["card"], metadata,
      ...(plan.recurring ? { subscription_data: { metadata } } : { payment_intent_data: { metadata }, invoice_creation: { enabled: true } }),
      billing_address_collection: "required", tax_id_collection: { enabled: true }, customer_update: { address: "auto", name: "auto" },
      automatic_tax: { enabled: config.BILLING_AUTOMATIC_TAX },
      success_url: outcomeUrl("success"), cancel_url: outcomeUrl("cancelled"),
    };
    // Persist the exact parameters: configuration changes cannot alter a retry.
    if (!account.checkout.params) {
      account.checkout.params = params;
      await account.save();
    }
    if (!plan.recurring) {
      const acceptedPrice = (account.checkout.params as Stripe.Checkout.SessionCreateParams).line_items?.[0]?.price;
      if (acceptedPrice) await BillingPrice.updateOne({ _id: acceptedPrice }, { $setOnInsert: { planId } }, { upsert: true });
    }
    const session = await stripe.checkout.sessions.create(account.checkout.params as Stripe.Checkout.SessionCreateParams, { idempotencyKey: account.checkout.key });
    account.checkout.id = session.id;
    await account.save();
    return session.url;
  });
}

export async function cancelAccountBilling(owner: string) {
  const account = await BillingAccount.findById(owner).lean();
  if (!account?.customerId) return;
  if (account.checkout?.key && !account.checkout.id) throw billingError("billing_checkout_in_progress", 409);
  await withBillingLock(`checkout:${owner}`, async () => {
    const account = await BillingAccount.findById(owner).lean();
    if (!account?.customerId) return;
    if (account.checkout?.key && !account.checkout.id) throw billingError("billing_checkout_in_progress", 409);
    const stripe = stripeClient();
    if (account.checkout?.id) {
      const session = await stripe.checkout.sessions.retrieve(account.checkout.id);
      if (session.status === "open") await stripe.checkout.sessions.expire(session.id);
    }
    for await (const subscription of stripe.subscriptions.list({ customer: account.customerId, status: "all", limit: 100 })) {
      if (!["canceled", "incomplete_expired"].includes(subscription.status)) await stripe.subscriptions.cancel(subscription.id);
    }
    await BillingGrant.updateMany({ owner, subscriptionId: { $exists: true } }, { $set: { status: "canceled" }, $inc: { revision: 1 } });
  });
}
