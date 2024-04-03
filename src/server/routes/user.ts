import * as express from "express";
import config from "../../config";
import { ensureAuthenticated } from "./connection";
import { handleError, getUser, isOwnerOrAdmin } from "./route-utils";
import UserModel from "../../core/model/users/users.model";
import User from "../../core/User";

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
    const sizes = await Promise.all(
      repositories
        .filter((r) => r.status == "ready")
        .map((r) => r.computeSize())
    );
    res.json({
      storage: {
        used: sizes.reduce((sum, i) => sum + i.storage, 0),
        total: config.DEFAULT_QUOTA,
      },
      file: {
        used: sizes.reduce((sum, i) => sum + i.file, 0),
        total: 0,
      },
      repository: {
        used: repositories.filter((f) => f.status == "ready").length,
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
