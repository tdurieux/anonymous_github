import DashboardName from "../../core/model/dashboard-name";
import { ensureDashboardNames } from "./dashboard-names";
import { PipelineStage, Types } from "mongoose";
import User from "../../core/User";
import Repo from "../../core/model/anonymizedRepositories/anonymizedRepositories.model";
import PullRequest from "../../core/model/anonymizedPullRequests/anonymizedPullRequests.model";
import Gist from "../../core/model/anonymizedGists/anonymizedGists.model";
import AnonymousError from "../../core/AnonymousError";

const fields: Record<string, string> = { _name: "_anonymousId", _label: "_label", status: "status",
  anonymizeDate: "anonymizeDate", lastView: "lastView", pageView: "pageView", "options.expirationDate": "options.expirationDate" };
export function dashboardPipeline(user: User, query: Record<string, unknown>, now = new Date()): PipelineStage[] {
  const sort = String(query.sort || "-anonymizeDate");
  const field = sort.replace(/^-/, "");
  if (!fields[field]) throw new AnonymousError("invalid_sort", { httpStatus: 400 });
  const direction = sort.startsWith("-") ? -1 : 1;
  const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit)) || 50));
  const owner = new Types.ObjectId(user.id);

  function project(type: string, id: string, source: unknown, label: unknown, extra: Record<string, unknown>) {
    return [
      { $project: { _id: 1, status: 1, statusMessage: 1, anonymizeDate: 1, lastView: 1, pageView: { $ifNull: ["$pageView", 0] },
        options: 1, conference: 1, ...extra, _type: { $literal: type }, _anonymousId: { $ifNull: [`$${id}`, ""] },
        _source: source, _fallbackLabel: label,

      } },
    ];
  }
  const repoProject = project("repo", "repoId", "$source.repositoryName", "$source.repositoryName", {
    repoId: 1, source: { fullName: "$source.repositoryName", commit: "$source.commit" }, coauthors: 1, size: 1,
    role: { $cond: [{ $eq: ["$owner", owner] }, "owner", "coauthor"] },
  });
  const prProject = project("pr", "pullRequestId", { $concat: [{ $ifNull: ["$source.repositoryFullName", ""] }, "#", { $toString: "$source.pullRequestId" }] },
    { $concat: [{ $ifNull: ["$source.repositoryFullName", ""] }, "#", { $toString: "$source.pullRequestId" }] },
    { pullRequestId: 1, source: { repositoryFullName: "$source.repositoryFullName", pullRequestId: "$source.pullRequestId" } });
  const gistProject = project("gist", "gistId", "$source.gistId", { $concat: ["Gist ", { $ifNull: ["$gistId", "$source.gistId"] }] },
    { gistId: 1, source: { gistId: "$source.gistId" }, isPublic: "$gist.isPublic" });
  const pipeline: PipelineStage[] = [
    { $match: { $or: user.repositoryMembership().$or.map(clause => clause.owner ? { owner } : clause) } }, ...repoProject as PipelineStage[],
    { $unionWith: { coll: PullRequest.collection.name, pipeline: [{ $match: { owner } }, ...prProject] } },
    { $unionWith: { coll: Gist.collection.name, pipeline: [{ $match: { owner } }, ...gistProject] } },
    { $lookup: { from: DashboardName.collection.name, let: { type: "$_type", id: "$_anonymousId" },
      pipeline: [{ $match: { owner, $expr: { $and: [{ $eq: ["$type", "$$type"] }, { $eq: ["$artifactId", "$$id"] }] } } },
        { $project: { name: 1 } }], as: "_privateName" } },
    { $set: { projectName: { $ifNull: [{ $arrayElemAt: ["$_privateName.name", 0] }, ""] } } },
    { $unset: "_privateName" },
    { $set: { status: { $cond: [{ $and: [{ $eq: ["$status", "ready"] }, { $ne: ["$options.expirationMode", "never"] },
      { $ne: [{ $ifNull: ["$options.expirationDate", null] }, null] }, { $lte: ["$options.expirationDate", now] }] }, "expired", "$status"] },
      _label: { $cond: [{ $ne: ["$projectName", ""] }, "$projectName", { $ifNull: ["$_fallbackLabel", "$_anonymousId"] }] } } },
    { $set: { _statusKey: { $switch: { branches: [
      { case: { $in: ["$status", ["ready", "error"]] }, then: "$status" },
      { case: { $in: ["$status", ["expired", "expiring"]] }, then: "expired" },
      { case: { $in: ["$status", ["removed", "removing"]] }, then: "removed" },
    ], default: "progress" } } } },
    { $set: { _attention: { $or: [{ $eq: ["$status", "error"] }, { $eq: ["$_anonymousId", ""] },
      { $and: [{ $eq: ["$_statusKey", "progress"] }, { $ne: [{ $ifNull: ["$anonymizeDate", "$lastView"] }, null] },
        { $lt: [{ $ifNull: ["$anonymizeDate", "$lastView"] }, new Date(now.getTime() - 2 * 3600_000)] }] }] },
      _sort: { $ifNull: [`$${fields[field]}`, ["pageView", "anonymizeDate", "lastView", "options.expirationDate"].includes(field)
        ? (["pageView"].includes(field) ? 0 : new Date(0)) : ""] } } },
  ];
  if (["_name", "_label", "status"].includes(field)) pipeline.push({ $set: { _sort: { $toLower: "$_sort" } } });
  const filter: Record<string, unknown> = {};
  if (["repo", "pr", "gist"].includes(String(query.type))) filter._type = query.type;
  if (query.attention === "true") filter._attention = true;
  const statuses = String(query.statuses || "ready,progress,error,expired").split(",").filter(s => ["ready", "progress", "error", "expired", "removed"].includes(s));
  filter._statusKey = { $in: statuses };
  const search = String(query.q || "").trim().slice(0, 256);
  if (search) {
    const pattern = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = ["_anonymousId", "_label", "_source", "conference"].map(key => ({ [key]: { $regex: pattern, $options: "i" } }));
  }
  const page: PipelineStage.FacetPipelineStage[] = [{ $match: filter }];
  if (query.cursor) {
    try {
      if (String(query.cursor).length > 2048) throw new Error();
      const cursor = JSON.parse(Buffer.from(String(query.cursor), "base64url").toString());
      if (cursor.sort !== sort || typeof cursor.type !== "string" || !Types.ObjectId.isValid(cursor.id)) throw new Error();
      const value = ["anonymizeDate", "lastView", "options.expirationDate"].includes(field) ? new Date(cursor.value) : cursor.value;
      if ((value instanceof Date && isNaN(value.getTime())) || !(typeof value === "string" || typeof value === "number" || value instanceof Date)) throw new Error();
      page.push({ $match: { $or: [ { _sort: { [direction === 1 ? "$gt" : "$lt"]: value } },
        { _sort: value, _type: { $gt: cursor.type } }, { _sort: value, _type: cursor.type, _id: { $gt: new Types.ObjectId(cursor.id) } },
      ] } });
    } catch { throw new AnonymousError("invalid_cursor", { httpStatus: 400 }); }
  }
  page.push({ $sort: { _sort: direction, _type: 1, _id: 1 } }, { $limit: limit + 1 });
  pipeline.push({ $facet: { totals: [{ $group: { _id: null, total: { $sum: 1 }, attention: { $sum: { $cond: ["$_attention", 1, 0] } } } }],
    filtered: [{ $match: filter }, { $count: "count" }], items: page } });
  return pipeline;
}
export async function dashboardSummary(user: User, query: Record<string, unknown>) {
  await ensureDashboardNames(user);
  const [result] = await Repo.aggregate(dashboardPipeline(user, query));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit)) || 50));
  const hasMore = result.items.length > limit;
  const items = result.items.slice(0, limit);
  const last = items[items.length - 1];
  const cursor = hasMore ? Buffer.from(JSON.stringify({ sort: String(query.sort || "-anonymizeDate"),
    value: last._sort, type: last._type, id: last._id })).toString("base64url") : null;
  for (const item of items) { delete item._sort; delete item._id; }
  return { items, cursor, total: result.totals[0]?.total || 0, attention: result.totals[0]?.attention || 0,
    filtered: result.filtered[0]?.count || 0 };
}
