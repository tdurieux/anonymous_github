import { randomUUID } from "crypto";
import { mongo } from "mongoose";
import UserModel from "./model/users/users.model";
import { createLogger } from "./logger";

const logger = createLogger("email-history");
export const EMAIL_HISTORY = "email_delivery_history";
export interface EmailHistoryRecord {
  _id: string;
  kind: "repository-expiration" | "owner-access";
  recipient: string;
  ownerId: string;
  resourceId: string;
  resourceKind: string;
  createdAt: Date;
  completedAt?: Date;
  state: "sending" | "accepted" | "rejected" | "unknown";
  httpStatus?: number;
}
export const emailHistoryCollection = () => UserModel.db.collection(EMAIL_HISTORY) as unknown as mongo.Collection<EmailHistoryRecord>;
let indexed: Promise<unknown> | undefined;
export async function ensureEmailHistoryIndexes() {
  if (!indexed) indexed = Promise.all([
    emailHistoryCollection().createIndex({ createdAt: -1, _id: -1 }),
    emailHistoryCollection().createIndex({ state: 1, createdAt: -1, _id: -1 }),
    emailHistoryCollection().createIndex({ kind: 1, createdAt: -1, _id: -1 }),
  ]).catch(error => { indexed = undefined; throw error; });
  await indexed;
}

/** Store metadata only: never API keys, message bodies, or provider error bodies. */
export async function sendTrackedEmail(metadata: Pick<EmailHistoryRecord, "kind" | "recipient" | "ownerId" | "resourceId" | "resourceKind">,
  url: string, options: RequestInit): Promise<Response> {
  const id = randomUUID(), createdAt = new Date();
  let recorded = false;
  const recording = (async () => {
    try {
      if (UserModel.db.readyState === 1) {
        await ensureEmailHistoryIndexes();
        await emailHistoryCollection().insertOne({ _id: id, ...metadata, createdAt, state: "sending" });
        recorded = true;
      }
    } catch { logger.warn("email history write unavailable"); }
  })();
  // Start the provider request immediately after the caller commits dispatch.
  // Auditing must not add a preparation gap to owner lifecycle fencing.
  const complete = async (state: EmailHistoryRecord["state"], httpStatus?: number) => {
    const completedAt = new Date();
    await recording;
    if (!recorded) return;
    try {
      await emailHistoryCollection().updateOne({ _id: id }, { $set: { state, completedAt, ...(httpStatus ? { httpStatus } : {}) } });
    } catch { logger.warn("email history completion unavailable", { id }); }
  };
  let response: Response;
  try { response = await fetch(url, options); }
  catch (error) { await complete("unknown"); throw error; }
  await complete(response.ok ? "accepted" : "rejected", response.status);
  return response;
}
