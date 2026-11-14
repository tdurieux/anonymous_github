import { sendTrackedEmail } from "./email-history";
import config from "../config";
import RepositoryModel from "./model/anonymizedRepositories/anonymizedRepositories.model";
import UserModel from "./model/users/users.model";
import { notificationEmail } from "./owner-notifications";
import { createLogger } from "./logger";
import { RepositoryStatus } from "./types";

const logger = createLogger("repository-expiration-email");

/** Attempt delivery once per repository expiration date, across all workers. */
export async function notifyRepositoryExpired(id: unknown): Promise<void> {
  if (!config.RESEND_API_KEY || !config.EMAIL_FROM) return;
  try {
    const repo = await RepositoryModel.findOne({ _id: id, status: RepositoryStatus.EXPIRED }).lean();
    const expirationDate = repo?.options.expirationDate;
    if (!repo || repo.options.expirationMode === "never" || !expirationDate || expirationDate > new Date()) return;
    const owner = await UserModel.findOne({ _id: repo.owner, status: { $nin: ["removed", "banned"] } }).lean();
    const to = owner && notificationEmail(owner.emails, owner.notificationEmail);
    if (!to) return;
    const base = /^https?:\/\//.test(config.APP_HOSTNAME) ? config.APP_HOSTNAME : `https://${config.APP_HOSTNAME}`;
    const url = new URL("/dashboard", base).href;
    const claim = await RepositoryModel.updateOne({
      _id: repo._id, owner: repo.owner, status: RepositoryStatus.EXPIRED, statusDate: repo.statusDate,
      "options.expirationMode": repo.options.expirationMode,
      "options.expirationDate": expirationDate,
      expirationEmailClaimedFor: { $ne: expirationDate },
    }, { $set: { expirationEmailClaimedFor: expirationDate } }).exec();
    if (!claim.matchedCount) return;
    // Keep the claim even after a timeout: the provider may have accepted the email.
    const response = await sendTrackedEmail({ kind: "repository-expiration", recipient: to, ownerId: String(repo.owner),
      resourceId: String(repo._id), resourceKind: "repository" }, "https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json",
        "Idempotency-Key": `repository-expired/${repo._id}/${expirationDate.getTime()}` },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        from: config.EMAIL_FROM, to: [to], subject: "Your Anonymous GitHub repository has expired",
        text: `Your anonymized repository "${repo.repoId}" expired on ${expirationDate.toISOString().slice(0, 10)} (UTC).\n\nIts anonymized content is no longer available.${repo.options.expirationMode === "redirect" ? " Its link now redirects to the original repository." : ""}\n\nOpen your dashboard to manage your repositories:\n${url}\n\nYou are receiving this email because you own this repository on Anonymous GitHub. You can change your alert address on the connections page.\n`,
      }),
    });
    if (response.ok) logger.info("repository expiration email accepted", { repoId: repo.repoId });
    else logger.warn("repository expiration email delivery failed", { repoId: repo.repoId, httpStatus: response.status });
  } catch {
    // Email delivery must not interrupt expiration or expose addresses in logs.
    logger.warn("repository expiration email unavailable");
  }
}
