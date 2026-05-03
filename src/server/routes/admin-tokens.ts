import * as express from "express";
import { handleError, getUser, isOwnerOrAdmin } from "./route-utils";
import UserModel from "../../core/model/users/users.model";
import { generateToken, hashToken } from "./token-auth";

const router = express.Router();

router.use(async (req, res, next) => {
  try {
    const user = await getUser(req);
    isOwnerOrAdmin([], user);
    next();
  } catch (error) {
    handleError(error, res, req);
  }
});

router.get("/", async (req, res) => {
  try {
    const user = await getUser(req);
    const model = await UserModel.findById(user.model.id);
    if (!model) return res.status(404).json({ error: "user_not_found" });
    const tokens = (model.apiTokens || []).map((t) => ({
      id: t._id,
      name: t.name,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
    }));
    res.json(tokens);
  } catch (error) {
    handleError(error, res, req);
  }
});

router.post("/", async (req, res) => {
  try {
    const user = await getUser(req);
    const name = (req.body?.name || "").toString().trim() || "unnamed";
    const plaintext = generateToken();
    const tokenHash = hashToken(plaintext);

    const model = await UserModel.findById(user.model.id);
    if (!model) return res.status(404).json({ error: "user_not_found" });
    if (!model.apiTokens) model.apiTokens = [];
    model.apiTokens.push({
      tokenHash,
      name,
      createdAt: new Date(),
    });
    await model.save();

    const created = model.apiTokens[model.apiTokens.length - 1];
    res.json({
      id: created._id,
      name: created.name,
      createdAt: created.createdAt,
      token: plaintext,
    });
  } catch (error) {
    handleError(error, res, req);
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const user = await getUser(req);
    const result = await UserModel.updateOne(
      { _id: user.model.id },
      { $pull: { apiTokens: { _id: req.params.id } } }
    );
    res.json({ removed: result.modifiedCount });
  } catch (error) {
    handleError(error, res, req);
  }
});

export default router;
