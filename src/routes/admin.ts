import * as express from "express";
import AnonymizedRepositoryModel from "../database/anonymizedRepositories/anonymizedRepositories.model";
import ConferenceModel from "../database/conference/conferences.model";
import RepositoryModel from "../database/repositories/repositories.model";
import UserModel from "../database/users/users.model";
import { downloadQueue, removeQueue } from "../queue";
import Repository from "../Repository";
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
  ]);
  res.json({
    downloadQueue: out[0],
    removeQueue: out[1],
  });
});

router.get("/repos", async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const ready = req.query.ready == "true";
  const error = req.query.error == "true";
  const preparing = req.query.preparing == "true";
  const remove = req.query.remove == "true";
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
  let status = [];
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
  res.json({
    query: { $and: query },
    page,
    total: await AnonymizedRepositoryModel.find({ $and: query }).estimatedDocumentCount(),
    sort,
    results: await AnonymizedRepositoryModel.find({ $and: query })
      .sort(sort)
      .limit(limit)
      .skip(skipIndex),
  });
});

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
    total: await UserModel.find(query).estimatedDocumentCount(),
    sort,
    results: await UserModel.find(query)
      .sort(sort)
      .limit(limit)
      .skip(skipIndex),
  });
});

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
