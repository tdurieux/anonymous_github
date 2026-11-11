import Repository from "./Repository";
import AnonymizedFile from "./AnonymizedFile";
import AnonymousError from "./AnonymousError";
import FileModel from "./model/files/files.model";
import { FILE_LISTING_LIMIT } from "./file-tree";
import { anonymizePathCompiled, compileTerms } from "./anonymize-utils";

/** Only return the current folder and its immediate children, never a whole tree. */
export async function folderCounts(repo: Repository, requestedPath: unknown): Promise<Record<string, number>> {
  if (typeof requestedPath !== "string" || requestedPath.length > 4096 ||
      requestedPath.split("/").some(part => part === "." || part === "..") ||
      (requestedPath !== "" && (requestedPath.startsWith("/") || requestedPath.endsWith("/")))) {
    throw new AnonymousError("invalid_path", { httpStatus: 400 });
  }
  let originalPath = "";
  if (requestedPath) {
    // Use the same collision resolution as browsing that anonymized directory.
    const directory = await new AnonymizedFile({ repository: repo, anonymizedPath: requestedPath }).getFileInfo();
    if (directory.size != null) throw new AnonymousError("folder_not_supported", { httpStatus: 404 });
    originalPath = [directory.path, directory.name].filter(Boolean).join("/");
  }
  const prefix = originalPath ? originalPath + "/" : "";
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const childDepth = originalPath ? originalPath.split("/").length : 0;
  const rows = await FileModel.aggregate<{ _id: string; count: number }>([
    { $match: {
      repoId: repo.repoId,
      treeGeneration: repo.model.treeGeneration || { $exists: false },
      size: { $ne: null },
      ...(originalPath ? { $or: [{ path: originalPath }, { path: { $regex: "^" + escapedPrefix } }] } : {}),
    } },
    // Group directly by the immediate child using only indexed fields.
    { $group: { _id: originalPath ? { $cond: [
      { $eq: ["$path", { $literal: originalPath }] }, "",
      { $arrayElemAt: [{ $split: ["$path", "/"] }, childDepth] },
    ] } : { $arrayElemAt: [{ $split: ["$path", "/"] }, 0] }, count: { $sum: 1 } } },
    { $limit: FILE_LISTING_LIMIT + 1 },
  ]).option({ maxTimeMS: 2000, allowDiskUse: true }).exec();
  if (rows.length > FILE_LISTING_LIMIT) throw new AnonymousError("file_listing_too_large", { httpStatus: 413 });
  const counts: Record<string, number> = Object.create(null);
  const compiled = compileTerms(repo.options.terms || []);
  let total = 0;
  for (const row of rows) {
    total += row.count;
    if (!row._id) continue;
    const anonymousPath = anonymizePathCompiled(prefix + row._id, compiled);
    counts[anonymousPath] = (counts[anonymousPath] || 0) + row.count;
  }
  counts[requestedPath] = total;
  return counts;
}
