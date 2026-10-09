import config from "../config";
import UserModel from "./model/users/users.model";
import { createLogger } from "./logger";

const logger = createLogger("owner-notifications");
const DAY = 24 * 60 * 60 * 1000;
const accessErrors = new Set([
  "token_expired", "github_oauth_required", "github_app_reconnect_required",
  "github_app_access_required", "repo_not_found", "repository_not_found",
  "repo_not_accessible", "repo_access_limited", "repo_saml_enforcement",
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

export function notificationEmail(emails?: { email: string; default: boolean }[]): string {
  return normalizeEmail(emails?.find(e => e.default)?.email) ||
    emails?.map(e => normalizeEmail(e.email)).find(Boolean) || "";
}

export function isAccessFailure(error: unknown): boolean {
  const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (!accessErrors.has(code)) return false;
  if (error instanceof Error) {
    const upstream = (error as Error & { cause?: { status?: number; httpStatus?: number } }).cause;
    // Some legacy paths wrap timeouts or 5xx responses as repo_not_found.
    // Only a confirmed access failure should prompt the owner to reconnect.
    if (upstream && ![401, 403, 404].includes(upstream.status || upstream.httpStatus || 0)) return false;
    const status = (error as Error & { httpStatus?: number }).httpStatus;
    if (status && (status === 429 || status >= 500)) return false;
  }
  return true;
}

/** Best effort; mail and database failures must not change repository behavior. */
export async function notifyOwnerAccessProblem(ownerId: string, error: unknown): Promise<void> {
  if (!config.RESEND_API_KEY || !config.EMAIL_FROM || !isAccessFailure(error)) return;
  try {
    const now = new Date();
    // The atomic claim limits all repositories and workers to one email per owner
    // per day. Claim before sending so concurrent requests cannot flood an inbox.
    const owner = await UserModel.findOneAndUpdate({
      _id: ownerId, status: { $nin: ["removed", "banned"] },
      "emails.0": { $exists: true },
      $or: [{ accessAlertAfter: { $exists: false } }, { accessAlertAfter: { $lte: now } }],
    }, { $set: { accessAlertAfter: new Date(now.getTime() + DAY) } }, { new: true }).lean();
    if (!owner) return;
    const to = notificationEmail(owner.emails);
    if (!to) return;
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
      // Permit retry on a later access failure, with a short backoff for outages.
      await UserModel.updateOne({ _id: ownerId, accessAlertAfter: new Date(now.getTime() + DAY) },
        { $set: { accessAlertAfter: new Date(now.getTime() + 10 * 60000) } });
      logger.warn("owner access email delivery failed");
    }
  } catch {
    // Do not log provider errors, which can contain credentials or addresses.
    logger.warn("owner access email unavailable");
  }
}
