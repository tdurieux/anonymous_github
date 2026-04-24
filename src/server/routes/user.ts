import * as express from "express";
import config from "../../config";
import { ensureAuthenticated } from "./connection";
import { handleError, getUser, isOwnerOrAdmin } from "./route-utils";
import UserModel from "../../core/model/users/users.model";
import User from "../../core/User";
import FileModel from "../../core/model/files/files.model";
import { isConnected } from "../database";

const router = express.Router();

// user needs to be connected for all user API
router.use(ensureAuthenticated);

router.get("/logout", async (req: express.Request, res: express.Response) => {
  try {
    req.logout((error) => {
      if (error) {
        console.error(`[ERROR] Logout error: ${error}`);
      }
    });
    res.redirect("/");
  } catch (error) {
    handleError(error, res, req);
  }
});

router.get("/", async (req: express.Request, res: express.Response) => {
  try {
    const user = await getUser(req);
    res.json({
      username: user.username,
      photo: user.photo,
      isAdmin: user.isAdmin,
    });
  } catch (error) {
    handleError(error, res, req);
  }
});

router.get("/quota", async (req: express.Request, res: express.Response) => {
  try {
    const user = await getUser(req);
    const repositories = await user.getRepositories();
    const ready = repositories.filter((r) => r.status == "ready");

    let totalStorage = 0;
    let totalFiles = 0;
    const uncachedIds: string[] = [];
    for (const r of ready) {
      const cached = r.model.size;
      if (cached && cached.file) {
        totalStorage += cached.storage;
        totalFiles += cached.file;
      } else {
        uncachedIds.push(r.repoId);
      }
    }

    if (uncachedIds.length) {
      const agg = await FileModel.aggregate([
        { $match: { repoId: { $in: uncachedIds } } },
        {
          $group: {
            _id: "$repoId",
            storage: { $sum: "$size" },
            file: { $sum: 1 },
          },
        },
      ]);
      const byId = new Map<string, { storage: number; file: number }>();
      for (const row of agg) {
        byId.set(row._id, { storage: row.storage || 0, file: row.file || 0 });
      }
      for (const r of ready) {
        if (!uncachedIds.includes(r.repoId)) continue;
        const size = byId.get(r.repoId) || { storage: 0, file: 0 };
        totalStorage += size.storage;
        totalFiles += size.file;
        r.model.size = size;
      }
      if (isConnected) {
        await Promise.all(
          ready
            .filter((r) => uncachedIds.includes(r.repoId))
            .map((r) => r.model.save())
        );
      }
    }

    res.json({
      storage: {
        used: totalStorage,
        total: config.DEFAULT_QUOTA,
      },
      file: {
        used: totalFiles,
        total: 0,
      },
      repository: {
        used: ready.length,
        total: 20,
      },
    });
  } catch (error) {
    handleError(error, res, req);
  }
});

router.get("/default", async (req: express.Request, res: express.Response) => {
  try {
    const user = await getUser(req);

    res.json(user.default);
  } catch (error) {
    handleError(error, res, req);
  }
});

router.post("/default", async (req: express.Request, res: express.Response) => {
  try {
    const user = await getUser(req);

    const d = req.body;
    user.model.default = d;

    await user.model.save();
    res.send("ok");
  } catch (error) {
    handleError(error, res, req);
  }
});

router.get(
  "/anonymized_repositories",
  async (req: express.Request, res: express.Response) => {
    try {
      const user = await getUser(req);
      res.json(
        (await user.getRepositories()).map((x) => {
          return x.toJSON();
        })
      );
    } catch (error) {
      handleError(error, res, req);
    }
  }
);
router.get(
  "/anonymized_pull_requests",
  async (req: express.Request, res: express.Response) => {
    try {
      const user = await getUser(req);
      res.json(
        (await user.getPullRequests()).map((x) => {
          return x.toJSON();
        })
      );
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

async function getAllRepositories(user: User, force: boolean) {
  const repos = await user.getGitHubRepositories({
    force,
  });
  return repos.map((x) => {
    return {
      fullName: x.fullName,
      id: x.id,
    };
  });
}
router.get(
  "/all_repositories",
  async (req: express.Request, res: express.Response) => {
    try {
      const user = await getUser(req);
      res.json(await getAllRepositories(user, req.query.force == "1"));
    } catch (error) {
      handleError(error, res, req);
    }
  }
);
router.get(
  "/:username/all_repositories",
  async (req: express.Request, res: express.Response) => {
    try {
      const loggedUser = await getUser(req);
      isOwnerOrAdmin([req.params.username], loggedUser);
      const model = await UserModel.findOne({ username: req.params.username });
      if (!model) {
        throw new Error("User not found");
      }
      const user = new User(model);
      res.json(await getAllRepositories(user, req.query.force == "1"));
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

export default router;
