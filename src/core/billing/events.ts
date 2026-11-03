import Stripe = require("stripe");
import config from "../../config";
import { randomUUID } from "crypto";
import { BillingEvent, BillingAccount } from "./models";
import { processBillingEvent } from "./stripe";
import { createLogger } from "../logger";

const logger = createLogger("billing");
export function billingFailure(error: unknown) {
  const e = error as { type?: string; code?: string; requestId?: string };
  // Do not persist provider messages, request bodies, email addresses or keys.
  return [e?.type, e?.code, e?.requestId].filter(v => typeof v === "string" && /^[a-zA-Z0-9_]+$/.test(v)).join(":") || "billing_processing_failed";
}
export async function receiveBillingEvent(event: Stripe.Event) {
  const value = event.data.object as unknown as Record<string, unknown>;
  // Retain only routing references, never the full Stripe customer/payment payload.
  const parent = value.parent as { subscription_details?: { subscription?: unknown } } | undefined;
  const ref = (v: unknown) => typeof v === "string" ? v : (v as { id?: string } | null)?.id;
  const object = { id: value.id, parent: { subscription_details: { subscription: ref(parent?.subscription_details?.subscription) } }, payment_intent: ref(value.payment_intent),
    charge: ref(value.charge), amount: value.amount, amount_refunded: value.amount_refunded, refunded: value.refunded, disputed: value.disputed };
  const id = `${event.livemode ? "live" : "test"}:${event.account || "platform"}:${event.id}`;
  await BillingEvent.updateOne({ _id: id }, { $setOnInsert: { eventId: event.id, type: event.type, object } }, { upsert: true });
}
export async function processBillingInbox(limit = 25, processEvent = processBillingEvent, now = new Date()) {
  for (let i = 0; i < limit; i++) {
    const token = randomUUID();
    const namespace = /^(sk|rk)_live_/.test(config.STRIPE_SECRET_KEY) ? /^live:platform:/ : /^test:platform:/;
    const event = await BillingEvent.findOneAndUpdate({ _id: namespace, $or: [
      { state: "pending", nextAttemptAt: { $lte: now } },
      { state: "processing", leaseUntil: { $lte: now } },
    ] }, { $set: { state: "processing", token, leaseUntil: new Date(now.getTime() + 300_000) }, $inc: { attempts: 1 } },
    { new: true, sort: { receivedAt: 1 } });
    if (!event) break;
    try {
      await processEvent({ id: event.eventId, type: event.type, data: { object: event.object } } as Stripe.Event);
      await BillingEvent.updateOne({ _id: event._id, token }, { $set: { state: "complete", completedAt: new Date() }, $unset: { token: 1, leaseUntil: 1, lastError: 1 } });
    } catch (error) {
      const dead = event.attempts >= 12;
      const lastError = billingFailure(error);
      await BillingEvent.updateOne({ _id: event._id, token }, { $set: { state: dead ? "failed" : "pending", lastError,
        nextAttemptAt: new Date(now.getTime() + Math.min(3600_000, 1000 * 2 ** event.attempts)) }, $unset: { token: 1, leaseUntil: 1 } });
      logger.error(dead ? "billing event requires replay" : "billing event retry scheduled", { eventId: event.eventId, type: event.type, attempts: event.attempts, code: lastError });
    }
  }
}
export async function billingHealth() {
  const [pending, failed, oldest, unresolved, reconciliationFailed] = await Promise.all([
    BillingEvent.countDocuments({ state: { $in: ["pending", "processing"] } }),
    BillingEvent.countDocuments({ state: "failed" }),
    BillingEvent.findOne({ state: { $in: ["pending", "processing"] } }).sort({ receivedAt: 1 }).select("receivedAt").lean(),
    BillingAccount.countDocuments({ "checkout.key": { $exists: true }, "checkout.id": { $exists: false } }),
    BillingAccount.countDocuments({ reconcileError: { $exists: true } }),
  ]);
  return { pending, failed, oldestPendingSeconds: oldest?.receivedAt ? Math.floor((Date.now() - oldest.receivedAt.getTime()) / 1000) : 0, unresolved, reconciliationFailed };
}
