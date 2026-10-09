import { Types } from "mongoose";
import { isGitHubRateLimitError } from "./github-rate-limit";
import config from "../config";
import UserModel from "./model/users/users.model";
import { createLogger } from "./logger";

const logger = createLogger("owner-notifications");
const resourceCollections = {
  repository: "anonymizedrepositories",
  "pull-request": "anonymizedpullrequests",
  gist: "anonymizedgists",
} as const;
export interface AlertResource { kind: keyof typeof resourceCollections; id: string; }

// Only explicit owner actions call this; background fetches never reset alerts.
export async function resetOwnerAccessAlerts(ownerId: string, resource?: AlertResource): Promise<void> {
  if (UserModel.db.readyState !== 1 || !Types.ObjectId.isValid(ownerId)) return;
  try {
    const filter = { owner: new Types.ObjectId(ownerId),
      ...(resource ? { _id: new Types.ObjectId(resource.id) } : {}) };
    for (const collection of resource ? [resourceCollections[resource.kind]] : Object.values(resourceCollections)) {
      await UserModel.db.collection(collection).updateMany(filter, { $unset: { accessAlertClaimedAt: "" } });
    }
  } catch { logger.warn("owner access alert reset unavailable"); }
}
const accessErrors = new Set([
  "token_expired", "github_oauth_required", "github_app_reconnect_required",
  "github_app_access_required", "repo_not_found", "repository_not_found",
  "file_not_accessible", "file_not_found", "pull_request_not_found", "gist_not_found", "repo_not_accessible", "repo_access_limited", "repo_saml_enforcement",
]);

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  // Accept one plain mailbox, never a display name or recipient list.
  if (email.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(email)) return null;
  const local = email.split("@")[0];
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || email.includes("..")) return null;
  return email;
}

export function notificationEmail(emails?: { email: string; default: boolean }[], preferred?: string): string {
  return normalizeEmail(preferred) || normalizeEmail(emails?.find(e => e.default)?.email) ||
    emails?.map(e => normalizeEmail(e.email)).find(Boolean) || "";
}

export function isAccessFailure(error: unknown): boolean {
  if (isGitHubRateLimitError(error)) return false;
  const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const rawStatus = error instanceof Error ? (error as Error & { status?: number }).status : undefined;
  if (!accessErrors.has(code) && ![401, 403, 404].includes(rawStatus || 0)) return false;
  if (error instanceof Error) {
    const upstream = (error as Error & { cause?: { status?: number; httpStatus?: number; response?: { statusCode?: number } } }).cause;
    // Some legacy paths wrap timeouts or 5xx responses as repo_not_found.
    // Only a confirmed access failure should prompt the owner to reconnect.
    if (isGitHubRateLimitError(upstream)) return false;
    if (upstream && ![401, 403, 404].includes(upstream.status || upstream.response?.statusCode || upstream.httpStatus || 0)) return false;
    const status = (error as Error & { httpStatus?: number }).httpStatus;
    if (status && (status === 429 || status >= 500)) return false;
  }
  return true;
}

/** Best effort; mail and database failures must not change repository behavior. */
export async function notifyOwnerAccessProblem(ownerId: string, error: unknown, resource: AlertResource): Promise<void> {
  if (!config.RESEND_API_KEY || !config.EMAIL_FROM || !isAccessFailure(error)) return;
  try {
    if (!resource || !Types.ObjectId.isValid(resource.id) || !Types.ObjectId.isValid(ownerId)) return;
    const owner = await UserModel.findOne({ _id: ownerId, status: { $nin: ["removed", "banned"] } }).lean();
    if (!owner) return;
    const to = notificationEmail(owner.emails, owner.notificationEmail);
    if (!to) return;
    // Claim the resource atomically before delivery. This has no expiry: neither
    // repeated readers nor workers can send again until the owner acts.
    const claim = await UserModel.db.collection(resourceCollections[resource.kind]).updateOne({
      _id: new Types.ObjectId(resource.id), owner: new Types.ObjectId(ownerId),
      accessAlertClaimedAt: { $exists: false },
    }, { $set: { accessAlertClaimedAt: new Date() } });
    if (!claim.modifiedCount) return;
    const base = /^https?:\/\//.test(config.APP_HOSTNAME) ? config.APP_HOSTNAME : `https://${config.APP_HOSTNAME}`;
    const url = new URL("/connections", base).href;
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          from: config.EMAIL_FROM, to: [to],
          subject: "Your Anonymous GitHub connection needs attention",
          text: `Anonymous GitHub could not access GitHub using your connection, or could not read a repository.\n\nOpen your connections page to reconnect your account or restore repository access:\n${url}\n\nYou are receiving this email because you own content on Anonymous GitHub. You can change your alert address on the connections page.\n`,
        }),
      });
      if (!response.ok) throw new Error("email_delivery_failed");
    } catch {
      // Keep the claim even on failure: delivery can be ambiguous and no
      // automatic retry may send another email before owner action.
      logger.warn("owner access email delivery failed");
    }
  } catch {
    // Do not log provider errors, which can contain credentials or addresses.
    logger.warn("owner access email unavailable");
  }
}
