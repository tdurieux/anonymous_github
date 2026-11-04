import * as express from "express";
import { Types } from "mongoose";
import { getUser, handleError, isOwnerCoauthorOrAdmin } from "./route-utils";
import { generateToken, hashToken } from "./token-auth";
import UserModel from "../../core/model/users/users.model";
import { getRepository } from "../database";
import AnonymousError from "../../core/AnonymousError";

const router = express.Router();
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  // A restricted token must never mint credentials or become a session.
  if (req.headers.authorization || !req.isAuthenticated()) {
    return res.status(401).json({ error: "session_required" });
  }
  next();
});

router.get("/", async (req, res) => {
  try {
    const user = await getUser(req);
    res.json((user.model.apiTokens || []).filter(t => t.scope === "repository-maintenance")
      .map(t => ({ id: t._id, name: t.name, repoIds: t.repoIds, expiresAt: t.expiresAt,
        createdAt: t.createdAt, lastUsedAt: t.lastUsedAt })));
  } catch (error) { handleError(error, res, req); }
});

router.post("/", async (req, res) => {
  try {
    const user = await getUser(req);
    const { name, repoIds, expiresInDays = 30 } = req.body;
    if (typeof name !== "string" || !name.trim() || name.length > 80 ||
      !Array.isArray(repoIds) || !repoIds.length || repoIds.length > 20 ||
      !repoIds.every(id => typeof id === "string" && /^[a-zA-Z0-9_-]{3,200}$/.test(id)) ||
      !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 90) {
      throw new AnonymousError("invalid_token_options", { httpStatus: 400 });
    }
    for (const id of new Set<string>(repoIds)) {
      isOwnerCoauthorOrAdmin(await getRepository(id), user);
    }
    const token = generateToken();
    const entry = { _id: new Types.ObjectId(), name: name.trim(), scope: "repository-maintenance",
      repoIds: [...new Set(repoIds)], tokenHash: hashToken(token), createdAt: new Date(),
      expiresAt: new Date(Date.now() + expiresInDays * 86400_000) };
    const saved = await UserModel.updateOne({ _id: user.model._id,
      "apiTokens.50": { $exists: false } }, { $push: { apiTokens: entry } });
    if (!saved.matchedCount) throw new AnonymousError("token_limit_reached", { httpStatus: 409 });
    res.status(201).json({ id: entry._id, name: entry.name, repoIds: entry.repoIds,
      expiresAt: entry.expiresAt, token });
  } catch (error) { handleError(error, res, req); }
});

router.delete("/:id", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!Types.ObjectId.isValid(req.params.id)) throw new AnonymousError("invalid_token_id", { httpStatus: 400 });
    const result = await UserModel.updateOne({ _id: user.model._id },
      { $pull: { apiTokens: { _id: req.params.id, scope: "repository-maintenance" } } });
    res.json({ removed: result.modifiedCount });
  } catch (error) { handleError(error, res, req); }
});
export default router;
