import * as express from "express";
import * as crypto from "crypto";
import UserModel from "../../core/model/users/users.model";
import { createLogger, serializeError } from "../../core/logger";
import { isDisabledAccount } from "./auth-utils";

const logger = createLogger("token-auth");

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export async function bearerTokenAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  const header = req.headers["authorization"];
  if (!header || typeof header !== "string") return next();
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1].trim() || match[1].length > 512) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  const tokenHash = hashToken(match[1].trim());
  try {
    const model = await UserModel.findOne({ "apiTokens.tokenHash": tokenHash });
    const token = model?.apiTokens?.find(t => t.tokenHash === tokenHash);
    if (!model || !token || isDisabledAccount(model.status) ||
      (token.expiresAt && token.expiresAt.getTime() <= Date.now()) ||
      (token.scope && (!token.expiresAt || token.scope !== "repository-maintenance"))) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    if (token.scope) {
      if (!maintenanceTokenAllows(req.method, req.path, token.repoIds || [])) {
        res.status(403).json({ error: "token_scope_forbidden" });
        return;
      }
      res.locals.maintenanceToken = true;
      res.locals.maintenanceOwnerId = String(model._id);
    }

    // Mirror the shape produced by passport's verify() in connection.ts
    // so existing getUser()/route code works unchanged.
    req.user = {
      username: model.username,
      user: model,
    } as Express.User;

    // fire-and-forget last-used update
    UserModel.updateOne(
      { _id: model._id, "apiTokens.tokenHash": tokenHash },
      { $set: { "apiTokens.$.lastUsedAt": new Date() } }
    ).catch((err) =>
      logger.error("lastUsedAt update failed", serializeError(err))
    );
  } catch (err) {
    logger.error("lookup failed", serializeError(err));
    res.status(503).json({ error: "authentication_unavailable" });
    return;
  }
  return next();
}

/** Exact paths keep scoped tokens out of GitHub proxy and session routes. */
export function maintenanceTokenAllows(method: string, path: string, repoIds: string[]): boolean {
  const readOrEdit = path.match(/^\/api\/maintenance\/repositories\/([a-zA-Z0-9_-]+)\/?$/);
  if (readOrEdit && ["GET", "PATCH"].includes(method)) return repoIds.includes(readOrEdit[1]);
  const action = path.match(/^\/api\/repo\/([a-zA-Z0-9_-]+)\/(refresh|extend)\/?$/);
  return !!action && method === "POST" && repoIds.includes(action[1]);
}
