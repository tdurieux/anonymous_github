import { BillingAccount } from "./models";
import Stripe = require("stripe");
import { fulfillCheckout, syncSubscription, stripeClient, processBillingEvent, withBillingLock } from "./stripe";
import { billingFailure } from "./events";
import { createLogger } from "../logger";
const logger = createLogger("billing");

// Paginate provider history so a missing local grant is discoverable after restore
// or lost delivery. Only paid customer accounts are scanned, once per day.
export async function reconcileBillingAccount(owner: string, stripe = stripeClient()) {
  return withBillingLock(`reconcile:${owner}`, async () => {
    const account = await BillingAccount.findById(owner);
    if (!account?.customerId) throw new Error("billing_customer_missing");
    for await (const sub of stripe.subscriptions.list({ customer: account.customerId, status: "all", limit: 100 })) {
      await syncSubscription(sub.id, stripe);
    }
    for await (const session of stripe.checkout.sessions.list({ customer: account.customerId, limit: 100 })) {
      if (session.metadata?.application !== "anonymous-github" || session.metadata.owner !== owner) continue;
      if (account.checkout?.key && !account.checkout.id && session.metadata.attempt === account.checkout.key) {
        await BillingAccount.updateOne({ _id: owner, "checkout.key": account.checkout.key }, { $set: { "checkout.id": session.id } });
      }
      if (session.status === "complete") await fulfillCheckout(session.id, stripe);
    }
    // Refunds on older invoices must also survive lost webhook deliveries.
    for await (const charge of stripe.charges.list({ customer: account.customerId, limit: 100 })) {
      if (charge.refunded || charge.disputed) await processBillingEvent({ type: "charge.refunded", data: { object: { ...charge, refunded: true } } } as Stripe.Event, stripe);
    }
    await BillingAccount.updateOne({ _id: owner }, { $set: { reconciledAt: new Date(), reconcileAfter: new Date(Date.now() + 86400_000) }, $unset: { reconcileError: 1 } });
  });
}
export async function reconcileBillingAccounts(limit = 10) {
  const accounts = await BillingAccount.find({ customerId: { $exists: true }, $or: [
    { reconcileAfter: { $lte: new Date() } }, { reconcileAfter: { $exists: false } },
  ] }).sort({ reconcileAfter: 1 }).limit(limit).lean();
  for (const account of accounts) {
    try { await reconcileBillingAccount(account._id!); }
    catch (error) {
      const code = billingFailure(error);
      await BillingAccount.updateOne({ _id: account._id }, { $set: { reconcileAfter: new Date(Date.now() + 900_000), reconcileError: code } });
      logger.error("billing reconciliation deferred", { owner: account._id, code });
    }
  }
}

export async function discoverBillingCustomers(stripe = stripeClient()) {
  const Users = (await import("../model/users/users.model")).default;
  for await (const customer of stripe.customers.list({ limit: 100 })) {
    const owner = customer.metadata.owner;
    if (customer.metadata.application !== "anonymous-github" || !owner || !/^[a-f0-9]{24}$/i.test(owner)) continue;
    if (!await Users.exists({ _id: owner })) continue;
    const current = await BillingAccount.findById(owner);
    if (current?.customerId && current.customerId !== customer.id) {
      logger.error("duplicate Stripe customer requires review", { owner });
      continue;
    }
    await BillingAccount.updateOne({ _id: owner, $or: [{ customerId: { $exists: false } }, { customerId: customer.id }] },
      { $set: { customerId: customer.id, reconcileAfter: new Date(0) } }, { upsert: true });
  }
}
