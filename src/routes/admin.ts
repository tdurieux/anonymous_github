import * as express from "express";
import { downloadQueue, removeQueue } from "../queue";
import { ensureAuthenticated } from "./connection";
import { handleError, getUser, isOwnerOrAdmin } from "./route-utils";

const router = express.Router();

// user needs to be connected for all user API
router.use(ensureAuthenticated);
router.use(
  async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    const user = await getUser(req);
    try {
      // only admins are allowed here
      isOwnerOrAdmin([], user);
      next();
    } catch (error) {
      handleError(error, res);
    }
  }
);

router.get("/jobs", async (req, res) => {
  res.json(
    await Promise.all([
      downloadQueue.getJobs([
        "waiting",
        "active",
        "completed",
        "failed",
        "delayed",
      ]),
      removeQueue.getJobs([
        "waiting",
        "active",
        "completed",
        "failed",
        "delayed",
      ]),
    ])
  );
});

export default router;
