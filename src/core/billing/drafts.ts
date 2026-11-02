import { randomUUID } from "crypto";
import { BillingDraft } from "./models";
import { billingError } from "./config";

const fields = ["sourceUrl", "terms", "repoId", "source", "options", "conference", "githubConnection"];
export function validDraftPath(path: unknown): path is string {
  return typeof path === "string" && /^\/anonymize(?:\/[A-Za-z0-9_-]{1,200})?$/.test(path);
}
export async function saveBillingDraft(owner: string, path: unknown, values: unknown) {
  if (!validDraftPath(path) || !values || typeof values !== "object" || Array.isArray(values) ||
      Buffer.byteLength(JSON.stringify(values)) > 64 * 1024) throw billingError("billing_invalid_draft");
  const selected = Object.fromEntries(fields.filter(key => Object.prototype.hasOwnProperty.call(values, key))
    .map(key => [key, (values as Record<string, unknown>)[key]]));
  // A draft is private user input, never an authorization or an entitlement.
  return BillingDraft.create({ _id: randomUUID(), owner, path, values: selected,
    expiresAt: new Date(Date.now() + 7 * 86400_000) });
}
export async function getBillingDraft(owner: string, id: unknown) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw billingError("billing_draft_not_found", 404);
  const draft = await BillingDraft.findOne({ _id: id, owner, expiresAt: { $gt: new Date() } }).lean();
  if (!draft) throw billingError("billing_draft_not_found", 404);
  return draft;
}
