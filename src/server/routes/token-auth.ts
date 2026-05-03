import * as express from "express";
import * as crypto from "crypto";
import UserModel from "../../core/model/users/users.model";

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export async function bearerTokenAuth(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction
): Promise<void> {
  if (req.user) return next();

  const header = req.headers["authorization"];
  if (!header || typeof header !== "string") return next();
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return next();

  const tokenHash = hashToken(match[1].trim());
  try {
    const model = await UserModel.findOne({ "apiTokens.tokenHash": tokenHash });
    if (!model) return next();

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
    ).catch((err) => console.error("[token-auth] lastUsedAt update failed", err));
  } catch (err) {
    console.error("[token-auth] lookup failed", err);
  }
  return next();
}
