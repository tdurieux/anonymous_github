import { Document, Model } from "mongoose";
import { RepositoryStatus } from "./types";

type ContentSnapshot = Document & {
  status?: RepositoryStatus;
  statusDate?: Date;
  anonymizeDate?: Date;
  options: { expirationMode?: string; expirationDate?: Date };
  githubAccess?: { revision?: string };
};

// Embedded content and lifecycle state live in one document. Claim and clear
// them in one conditional write so an extension or rebuild cannot interleave.
export async function expireEmbeddedContent<T extends ContentSnapshot>(
  model: Model<T>, data: T, fields: Record<string, unknown>, unset: Record<string, ""> = {}
) {
  const now = new Date();
  const result = await model.updateOne({
    _id: data._id,
    status: data.status ?? { $exists: false },
    statusDate: data.statusDate ?? { $exists: false },
    anonymizeDate: data.anonymizeDate ?? { $exists: false },
    "options.expirationMode": data.options.expirationMode ?? { $exists: false },
    "options.expirationDate": data.options.expirationDate ?? { $exists: false },
    "githubAccess.revision": data.githubAccess?.revision ?? { $exists: false },
    $and: [
      { status: { $in: [RepositoryStatus.READY, RepositoryStatus.EXPIRING] } },
      { "options.expirationMode": { $ne: "never" } },
      { "options.expirationDate": { $lte: now } },
    ],
  }, { $set: { ...fields, status: RepositoryStatus.EXPIRED, statusDate: now }, $unset: unset }).exec();
  if (!result.matchedCount) return;
  data.set({ ...fields, status: RepositoryStatus.EXPIRED, statusDate: now });
  for (const key of Object.keys(unset)) data.set(key, undefined);
}
