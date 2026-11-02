import { Schema, model } from "mongoose";

// Billing records are separate from public user/repository serialization.
export const BillingAccount = model("billingAccount", new Schema({
  _id: String, customerId: String,
  customerAttemptAt: Date,
  reconciledAt: Date, reconcileAfter: { type: Date, default: () => new Date(0), index: true }, reconcileError: String,
  checkout: { id: String, key: String, planId: String, target: String, expiresAt: Date, createdAt: Date, params: Schema.Types.Mixed },
}));
export const BillingGrant = model("billingGrant", new Schema({
  _id: String, owner: { type: String, index: true }, scope: { type: String, index: true },
  planId: String, customerId: String, subscriptionId: String, paymentIntentId: { type: String, index: true },
  status: String, until: Date, cancelAtPeriodEnd: Boolean,
  priceId: String,
  revision: { type: Number, default: 0 }, revoked: { type: Boolean, default: false },
  revocationReason: String, revokedAt: Date,
}));
export const BillingQuota = model("billingQuota", new Schema({
  _id: String,
  allocations: [{ _id: false, repoId: String, reservationId: String, bytes: Number, baseBytes: Number,
    expansions: [{ _id: false, key: String, bytes: Number }], createdAt: Date }],
}));
// A short lease serializes Stripe checkout creation across API instances.
export const BillingLock = model("billingLock", new Schema({ _id: String, token: String, until: Date }));

const eventSchema = new Schema({
  _id: String, eventId: String, type: String, object: Schema.Types.Mixed,
  state: { type: String, default: "pending" }, attempts: { type: Number, default: 0 },
  receivedAt: { type: Date, default: Date.now }, nextAttemptAt: { type: Date, default: Date.now },
  leaseUntil: Date, token: String, completedAt: Date, lastError: String,
});
eventSchema.index({ state: 1, nextAttemptAt: 1, leaseUntil: 1 });
export const BillingEvent = model("billingEvent", eventSchema);
export const BillingAudit = model("billingAudit", new Schema({
  action: String, target: String, actor: String, reason: String, at: { type: Date, default: Date.now },
}));

// A reversal can arrive before its grant exists. Keep the payment-level decision.
export const BillingRevocation = model("billingRevocation", new Schema({
  _id: String, subscriptionId: String, reason: String, reviewed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
}));

// Short-lived, private task context. Explicit expiry checks also cover TTL sweep delays.
export const BillingDraft = model("billingDraft", new Schema({
  _id: String, owner: { type: String, required: true, index: true }, path: String, values: Schema.Types.Mixed,
  expiresAt: { type: Date, required: true, expires: 0 },
}));

// Accepted prices survive removal from the advertised catalog.
export const BillingPrice = model("billingPrice", new Schema({ _id: String, planId: String }));
