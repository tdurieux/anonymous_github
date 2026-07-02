import * as express from "express";
import got from "got";
import config from "../../config";
import { ensureAuthenticated } from "./connection";
import { handleError, getUser, isOwnerOrAdmin } from "./route-utils";
import UserModel from "../../core/model/users/users.model";
import AnonymizedRepositoryModel from "../../core/model/anonymizedRepositories/anonymizedRepositories.model";
import User from "../../core/User";
import FileModel from "../../core/model/files/files.model";
import { isConnected } from "../database";
import { octokit } from "../../core/GitHubUtils";
import { createLogger, serializeError } from "../../core/logger";

const logger = createLogger("user");

const router = express.Router();

// user needs to be connected for all user API
router.use(ensureAuthenticated);

router.get("/logout", async (req: express.Request, res: express.Response) => {
  try {
    req.logout((error) => {
      if (error) {
        logger.error("logout failed", serializeError(error));
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
    const repositories = (await user.getRepositories()).filter(
      (r) => r.owner.id === user.model.id
    );
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
      const uncachedSet = new Set(uncachedIds);
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
        if (!uncachedSet.has(r.repoId)) continue;
        const size = byId.get(r.repoId) || { storage: 0, file: 0 };
        totalStorage += size.storage;
        totalFiles += size.file;
        r.model.size = size;
      }
      if (isConnected) {
        await Promise.all(
          ready
            .filter((r) => uncachedSet.has(r.repoId))
            .map((r) =>
              AnonymizedRepositoryModel.updateOne(
                { _id: r.model._id },
                { $set: { size: r.model.size } }
              ).exec()
            )
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

    await UserModel.updateOne(
      { _id: user.model._id },
      { $set: { default: d } }
    ).exec();
    res.send("ok");
  } catch (error) {
    handleError(error, res, req);
  }
});

// Delete the account: remove all anonymized content owned by the user,
// best-effort revoke the GitHub OAuth grant, and scrub personal data from
// the user record (#741). The record itself is kept (with a placeholder
// username) so removed repoIds stay reserved and owner references remain
// resolvable.
router.delete("/", async (req: express.Request, res: express.Response) => {
  try {
    const user = await getUser(req);

    const repositories = (await user.getRepositories()).filter(
      (r) => r.owner.id === user.model.id && r.status !== "removed"
    );
    for (const repo of repositories) {
      await repo.remove();
    }
    for (const pullRequest of await user.getPullRequests()) {
      if (pullRequest.status !== "removed") await pullRequest.remove();
    }
    for (const gist of await user.getGists()) {
      if (gist.status !== "removed") await gist.remove();
    }

    // Revoke the OAuth grant so the application no longer appears in the
    // user's GitHub authorized applications. Best-effort: the account is
    // scrubbed even if GitHub rejects the revocation.
    try {
      await got.delete(
        `https://api.github.com/applications/${config.CLIENT_ID}/grant`,
        {
          username: config.CLIENT_ID,
          password: config.CLIENT_SECRET,
          headers: { accept: "application/vnd.github+json" },
          json: { access_token: user.accessToken },
        }
      );
    } catch (error) {
      logger.warn("oauth grant revocation failed", serializeError(error));
    }

    await UserModel.updateOne(
      { _id: user.model._id },
      {
        $set: {
          status: "removed",
          username: `deleted-${user.model._id}`,
          emails: [],
          apiTokens: [],
          repositories: [],
        },
        $unset: {
          accessTokens: "",
          accessTokenDates: "",
          externalIDs: "",
          photo: "",
          default: "",
        },
      }
    ).exec();

    logger.info("account removed", { userId: user.model.id });
    req.logout((error) => {
      if (error) {
        logger.error("logout after account removal failed", serializeError(error));
      }
      res.json({ status: "ok" });
    });
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
          const json = x.toJSON() as Record<string, unknown>;
          json.role = x.owner.id === user.model.id ? "owner" : "coauthor";
          return json;
        })
      );
    } catch (error) {
      handleError(error, res, req);
    }
  }
);
router.get(
  "/anonymized_gists",
  async (req: express.Request, res: express.Response) => {
    try {
      const user = await getUser(req);
      res.json(
        (await user.getGists()).map((x) => {
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

// search GitHub users (used by the coauthor picker)
router.get(
  "/search/github-users",
  async (req: express.Request, res: express.Response) => {
    try {
      const user = await getUser(req);
      const q = (req.query.q as string) || "";
      if (!q || q.length < 2) {
        return res.json([]);
      }
      const oct = octokit(user.accessToken);
      const r = await oct.search.users({ q, per_page: 10 });
      res.json(
        r.data.items.map((u) => ({
          username: u.login,
          githubId: String(u.id),
          photo: u.avatar_url,
        }))
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
