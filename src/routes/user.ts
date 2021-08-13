import * as express from "express";
import config from "../../config";
import { ensureAuthenticated } from "./connection";
import { handleError, getUser } from "./route-utils";

const router = express.Router();

// user needs to be connected for all user API
router.use(ensureAuthenticated);

router.get("/logout", async (req: express.Request, res: express.Response) => {
  try {
    req.logout();
    res.redirect("/");
  } catch (error) {
    handleError(error, res);
  }
});

router.get("/", async (req: express.Request, res: express.Response) => {
  try {
    const user = await getUser(req);
    res.json({ username: user.username, photo: user.photo });
  } catch (error) {
    handleError(error, res);
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
        used: repositories.length,
        total: 20,
      },
    });
  } catch (error) {
    handleError(error, res);
  }
});

router.get("/default", async (req: express.Request, res: express.Response) => {
  try {
    const user = await getUser(req);

    res.json(user.default);
  } catch (error) {
    handleError(error, res);
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
    handleError(error, res);
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
      handleError(error, res);
    }
  }
);

router.get(
  "/all_repositories",
  async (req: express.Request, res: express.Response) => {
    try {
      const user = await getUser(req);
      const repos = await user.getGitHubRepositories({
        force: req.query.force == "1",
      });
      res.json(
        repos.map((x) => {
          return {
            fullName: x.fullName,
            id: x.id,
          };
        })
      );
    } catch (error) {
      handleError(error, res);
    }
  }
);

export default router;
