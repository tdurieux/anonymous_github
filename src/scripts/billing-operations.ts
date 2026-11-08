import "dotenv/config";
import mongoose from "mongoose";
import config from "../config";
import { BillingAccount, BillingEvent, BillingAudit, BillingRevocation, BillingGrant } from "../core/billing/models";
import { billingHealth, processBillingInbox } from "../core/billing/events";
import { reconcileBillingAccount, discoverBillingCustomers } from "../core/billing/reconciliation";

async function main() {
  const [command, target, reason] = process.argv.slice(2);
  if (!["health", "inspect", "replay", "reconcile", "discover", "drain", "reinstate"].includes(command)) throw new Error("invalid_command");
  const mutations = ["replay", "reconcile", "discover", "drain", "reinstate"].includes(command);
  if (mutations && (!process.env.BILLING_OPERATOR || !reason)) throw new Error("operator_and_reason_required");
  const uri = config.MONGODB_URI || `mongodb://${config.DB_USERNAME}:${config.DB_PASSWORD}@${config.DB_HOSTNAME}:27017/production`;
  await mongoose.connect(uri, { autoIndex: false, ...(config.MONGODB_URI ? {} : { authSource: "admin" }) });
  if (mutations) await BillingAudit.create({ action: command, target, reason, actor: process.env.BILLING_OPERATOR });
  if (command === "reinstate") {
    const reversal = await BillingRevocation.findById(target);
    if (!reversal) throw new Error("payment_reversal_missing");
    reversal.reviewed = true;
    await reversal.save();
    if (reversal.subscriptionId && await BillingRevocation.exists({ subscriptionId: reversal.subscriptionId, reviewed: false })) {
      console.log("This payment is reviewed; other unresolved reversals still suspend the subscription.");
      return;
    }
    const affected = reversal.subscriptionId ? { _id: reversal.subscriptionId } : { paymentIntentId: target };
    await BillingGrant.updateMany(affected, { $set: { revoked: false }, $unset: { revocationReason: 1, revokedAt: 1 }, $inc: { revision: 1 } });
    console.log("Reinstatement recorded. Reconcile the owner to verify current paid time.");
  }
  if (command === "health") console.log(JSON.stringify(await billingHealth(), null, 2));
  if (command === "inspect") console.log(JSON.stringify(await BillingAccount.findById(target).select("customerId reconciledAt reconcileError checkout.id checkout.createdAt"), null, 2));
  if (command === "reconcile") await reconcileBillingAccount(target);
  if (command === "discover") await discoverBillingCustomers();
  if (command === "drain") await processBillingInbox(100);
  if (command === "replay") {
    const result = await BillingEvent.updateOne({ _id: target, state: { $in: ["failed", "complete", "pending"] } },
      { $set: { state: "pending", attempts: 0, nextAttemptAt: new Date() }, $unset: { completedAt: 1, lastError: 1 } });
    if (!result.matchedCount) throw new Error("event_not_replayable");
  }
}
main().catch(() => {
  console.error("Billing operation failed. Check the command, target, BILLING_OPERATOR, reason, and server configuration. No credentials were logged.");
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
