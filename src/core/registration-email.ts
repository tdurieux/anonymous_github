import UserModel from "./model/users/users.model";
import { IUserDocument } from "./model/users/users.types";
import { normalizeEmail, notificationEmail } from "./owner-notifications";

function usableEmail(value: unknown): string | null {
  const email = normalizeEmail(value);
  if (!email) return null;
  const domain = email.split("@")[1].toLowerCase();
  return ["users.noreply.github.com", "noreply.github.com"].includes(domain) ? null : email;
}

/** Fill a missing address after the GitHub identity has been authenticated. */
export async function saveRegistrationEmail(user: IUserDocument, token: string): Promise<void> {
  if (notificationEmail(user.emails, user.notificationEmail)) return;
  // Compare the original fields so a concurrent settings save always wins.
  const previousEmails = user.toObject().emails;
  const previousPreference = user.notificationEmail ?? null;
  try {
    const response = await fetch("https://api.github.com/user/emails?per_page=100", {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Anonymous-GitHub" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return;
    const data: unknown = await response.json();
    if (!Array.isArray(data)) return;
    const verified = data.filter((entry): entry is { email: string; primary?: boolean } =>
      !!entry && entry.verified === true && !!usableEmail(entry.email));
    const email = usableEmail((verified.find(entry => entry.primary === true) || verified[0])?.email);
    if (!email) return;
    const emails = [{ email, default: true }];
    const result = await UserModel.updateOne({ _id: user._id, notificationEmail: previousPreference,
      $or: [{ emails: previousEmails ?? [] },
        ...(!previousEmails?.length ? [{ emails: { $exists: false } }] : [])],
    }, { $set: { emails } });
    if (result.modifiedCount) user.emails = emails;
  } catch {
    // Missing App email permission or an upstream outage must not prevent login.
    // The existing email form remains available when automatic collection fails.
  }
}
