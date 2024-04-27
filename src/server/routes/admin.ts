import { Queue } from "bullmq";
import * as express from "express";
import AnonymousError from "../../core/AnonymousError";
import AnonymizedRepositoryModel from "../../core/model/anonymizedRepositories/anonymizedRepositories.model";
import ConferenceModel from "../../core/model/conference/conferences.model";
import UserModel from "../../core/model/users/users.model";
import { cacheQueue, downloadQueue, removeQueue } from "../../queue";
import Repository from "../../core/Repository";
import User from "../../core/User";
import { ensureAuthenticated } from "./connection";
import { handleError, getUser, isOwnerOrAdmin, getRepo } from "./route-utils";

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
      handleError(error, res, req);
    }
  }
);

router.post("/queue/:name/:repo_id", async (req, res) => {
  let queue: Queue<Repository, void>;
  if (req.params.name == "download") {
    queue = downloadQueue;
  } else if (req.params.name == "cache") {
    queue = cacheQueue;
  } else if (req.params.name == "remove") {
    queue = removeQueue;
  } else {
    return res.status(404).json({ error: "queue_not_found" });
  }
  let job;
  try {
    job = await queue.getJob(req.params.repo_id);
    if (!job) {
      return res.status(404).json({ error: "job_not_found" });
    }

    await job.retry();
    res.send("ok");
  } catch (error) {
    try {
      if (job) {
        await job.remove();
        queue.add(job.name, job.data, job.opts);
      }
      res.send("ok");
    } catch (error) {
      res.status(500).send("error_retrying_job");
    }
  }
});

router.delete("/queue/:name/:repo_id", async (req, res) => {
  let queue: Queue;
  if (req.params.name == "download") {
    queue = downloadQueue;
  } else if (req.params.name == "cache") {
    queue = cacheQueue;
  } else if (req.params.name == "remove") {
    queue = removeQueue;
  } else {
    return res.status(404).json({ error: "queue_not_found" });
  }
  try {
    const job = await queue.getJob(req.params.repo_id);
    if (!job) {
      return res.status(404).json({ error: "job_not_found" });
    }
    await job.remove();
    res.send("ok");
  } catch (error) {
    handleError(error, res, req);
  }
});

router.get("/queues", async (req, res) => {
  const out = await Promise.all([
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
    cacheQueue.getJobs(["waiting", "active", "completed", "failed", "delayed"]),
  ]);
  res.json({
    downloadQueue: out[0],
    removeQueue: out[1],
    cacheQueue: out[2],
  });
});

router.get("/repos", async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const ready = req.query.ready == "true";
  const error = req.query.error == "true";
  const preparing = req.query.preparing == "true";
  const remove = req.query.removed == "true";
  const expired = req.query.expired == "true";

  let sort: any = { _id: 1 };
  if (req.query.sort) {
    sort = {};
    sort[req.query.sort as string] = -1;
  }
  let query = [];
  if (req.query.search) {
    query.push({ repoId: { $regex: req.query.search } });
  }
  const status: { status: string }[] = [];
  query.push({ $or: status });
  if (ready) {
    status.push({ status: "ready" });
  }
  if (error) {
    status.push({ status: "error" });
  }
  if (expired) {
    status.push({ status: "expiring" });
    status.push({ status: "expired" });
  }
  if (remove) {
    status.push({ status: "removing" });
    status.push({ status: "removed" });
  }
  if (preparing) {
    status.push({ status: "preparing" });
    status.push({ status: "download" });
  }
  const skipIndex = (page - 1) * limit;
  const [total, results] = await Promise.all([
    AnonymizedRepositoryModel.find({
      $and: query,
    }).countDocuments(),
    AnonymizedRepositoryModel.find({ $and: query })
      .skip(skipIndex)
      .sort(sort)
      .limit(limit)
      .exec(),
  ]);
  res.json({
    query: { $and: query },
    page,
    total,
    sort,
    results,
  });
});

// delete a repository
router.delete(
  "/repos/:repoId/",
  async (req: express.Request, res: express.Response) => {
    const repo = await getRepo(req, res, { nocheck: true });
    if (!repo) return;
    try {
      await cacheQueue.add(repo.repoId, repo, { jobId: repo.repoId });
      return res.json({ status: repo.status });
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

router.get("/users", async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const skipIndex = (page - 1) * limit;

  let sort: any = { _id: 1 };
  if (req.query.sort) {
    sort = {};
    sort[req.query.sort as string] = -1;
  }
  let query = {};
  if (req.query.search) {
    query = { username: { $regex: req.query.search } };
  }

  res.json({
    query: query,
    page,
    total: await UserModel.find(query).countDocuments(),
    sort,
    results: await UserModel.find(query)
      .sort(sort)
      .limit(limit)
      .skip(skipIndex),
  });
});
router.get(
  "/users/:username",
  async (req: express.Request, res: express.Response) => {
    try {
      const model = await UserModel.findOne({
        username: req.params.username,
      }).populate({
        path: "repositories",
        model: "Repository",
        foreignField: "_id",
        localField: "repositories",
      });
      if (!model) {
        req.logout((error) => console.error(error));
        throw new AnonymousError("user_not_found", {
          httpStatus: 404,
        });
      }
      const user = new User(model);
      res.json(user);
    } catch (error) {
      handleError(error, res, req);
    }
  }
);
router.get(
  "/users/:username/repos",
  async (req: express.Request, res: express.Response) => {
    try {
      const model = await UserModel.findOne({ username: req.params.username });
      if (!model) {
        req.logout((error) => console.error(error));
        throw new AnonymousError("user_not_found", {
          httpStatus: 404,
        });
      }
      const user = new User(model);
      const repos = await user.getRepositories();
      res.json(repos);
    } catch (error) {
      handleError(error, res, req);
    }
  }
);
router.get("/conferences", async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const skipIndex = (page - 1) * limit;

  let sort: any = { _id: 1 };
  if (req.query.sort) {
    sort = {};
    sort[req.query.sort as string] = -1;
  }
  let query = {};
  if (req.query.search) {
    query = {
      $or: [
        { name: { $regex: req.query.search } },
        { conferenceID: { $regex: req.query.search } },
      ],
    };
  }
  res.json({
    query: query,
    page,
    total: await ConferenceModel.find(query).estimatedDocumentCount(),
    sort,
    results: await ConferenceModel.find(query)
      .sort(sort)
      .limit(limit)
      .skip(skipIndex),
  });
});

export default router;
