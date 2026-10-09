import { createHash } from "crypto";
import config from "../config";
import { getCredentialToken, replaceCredential } from "./credentials";
import { ExpiringMap } from "./expiring-map";
import { createLogger } from "./logger";

const logger = createLogger("github");
const cooldowns = new ExpiringMap<boolean>(1024);
const pending = new Map<string, Promise<string | null>>();

/** Only legacy OAuth tokens belong to the OAuth application's reset endpoint. */
export async function refreshLegacyToken(ownerId: string, previous: string): Promise<string | null> {
  if (!config.GITHUB_OAUTH_ENABLED || !config.CLIENT_ID || !config.CLIENT_SECRET ||
    config.CLIENT_ID === "CLIENT_ID" || config.CLIENT_SECRET === "CLIENT_SECRET" ||
    /^(gh[psur]_|github_pat_)/.test(previous)) return null;
  const key = createHash("sha256").update(JSON.stringify([ownerId, previous, config.CLIENT_ID, config.CLIENT_SECRET])).digest("hex");
  if (cooldowns.get(key)) return null;
  const running = pending.get(key);
  if (running) return running;
  if (pending.size >= 1024) return null;
  const refresh = async () => {
    let status = 502;
    try {
      const res = await fetch(`https://api.github.com/applications/${encodeURIComponent(config.CLIENT_ID)}/token`, {
        method: "PATCH", body: JSON.stringify({ access_token: previous }),
        signal: AbortSignal.timeout(5000),
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
          Authorization: "Basic " + Buffer.from(config.CLIENT_ID + ":" + config.CLIENT_SECRET).toString("base64") },
      });
      status = res.status;
      if (res.ok) {
        const body = await res.json().catch(() => null) as { token?: unknown } | null;
        if (typeof body?.token === "string" && body.token.length) {
          if (await replaceCredential(ownerId, previous, body.token)) return body.token;
          return (await getCredentialToken(ownerId)) || config.GITHUB_TOKEN;
        }
      } else {
        // Release the response connection even when only the status matters.
        await res.body?.cancel();
      }
    } catch {
      // The existing token can still work during a transient reset-endpoint failure.
    }
    cooldowns.set(key, true, status === 401 || status === 404 ? 30 * 60_000 : 60_000);
    logger.warn("token refresh failed; backing off", { code: "token_refresh_failed", httpStatus: status });
    return null;
  };
  const work = refresh();
  pending.set(key, work);
  try { return await work; }
  finally { if (pending.get(key) === work) pending.delete(key); }
}
