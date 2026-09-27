import { createHash, createHmac, timingSafeEqual } from "crypto";
import { Connection, ClientSession, Types } from "mongoose";
import {
  ConsumedReviewIntent,
  IntentConsumption,
  createReviewIntentConsumer,
} from "./review-intent-client";

type Principal = { accountId: string; sessionId: string };
type Authority = {
  accountId: string;
  repositoryId: string;
  repositoryName: string;
  role: "owner" | "coauthor";
};
type Quote = {
  version: 1;
  accountId: string;
  sessionHash: string;
  repositoryId: string;
  intent: ConsumedReviewIntent;
};
export type ConsentReceipt = Readonly<{
  clientId: string;
  intentId: string;
  accountId: string;
  repositoryId: string;
  role: "owner" | "coauthor";
  policy: ConsumedReviewIntent["policy"];
  requestId: string;
  confirmedAt: string;
}>;
type SavedConsent = {
  _id: string;
  accountId: string;
  repositoryId: string;
  requestId: string;
  ticketHash: string;
  receipt: ConsentReceipt;
};
export class ReviewConsentError extends Error {
  constructor(
    public readonly kind:
      "invalid" | "forbidden" | "expired" | "conflict" | "unavailable",
  ) {
    super("Review owner consent " + kind);
    this.name = "ReviewConsentError";
  }
}
const deny = (kind: ReviewConsentError["kind"]): never => {
  throw new ReviewConsentError(kind);
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const objectId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{24}$/.test(value);
function principal(value: Principal): {
  accountId: string;
  sessionHash: string;
} {
  if (
    !value ||
    !objectId(value.accountId) ||
    typeof value.sessionId !== "string" ||
    !/^[A-Za-z0-9_-]{24,256}$/.test(value.sessionId)
  )
    deny("invalid");
  return { accountId: value.accountId, sessionHash: hash(value.sessionId) };
}

/** Server-side consent storage. Principals must come from current authenticated
 * browser sessions, never request JSON. A future HTTP adapter must apply its
 * own same-origin/CSRF checks. No route or provider is enabled by this factory. */
export function createReviewOwnerConsent(
  connection: Connection,
  consumer: ReturnType<typeof createReviewIntentConsumer>,
  signingKey: Buffer,
) {
  if (!Buffer.isBuffer(signingKey) || signingKey.length !== 32) deny("invalid");
  const key = Buffer.from(signingKey);
  let activeTransactions = 0;
  const signature = (body: string) =>
    createHmac("sha256", key)
      .update("4open.review-consent/1." + body)
      .digest();
  function decode(ticket: string, who: ReturnType<typeof principal>): Quote {
    if (
      typeof ticket !== "string" ||
      ticket.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(ticket)
    )
      deny("invalid");
    const [body, encoded] = ticket.split(".");
    const supplied = Buffer.from(encoded, "base64url");
    if (
      supplied.length !== 32 ||
      supplied.toString("base64url") !== encoded ||
      !timingSafeEqual(supplied, signature(body))
    )
      deny("invalid");
    let quote: Quote;
    try {
      quote = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return deny("invalid");
    }
    if (
      quote.version !== 1 ||
      quote.accountId !== who.accountId ||
      quote.sessionHash !== who.sessionHash ||
      !objectId(quote.repositoryId)
    )
      deny("forbidden");
    if (
      Date.parse(quote.intent.expiresAt) <= Date.now() ||
      Date.parse(quote.intent.policy.retainUntil) <= Date.now()
    )
      deny("expired");
    return quote;
  }
  async function transaction<T>(
    who: ReturnType<typeof principal>,
    repository: { repoId: string } | { _id: Types.ObjectId },
    work: (authority: Authority, session: ClientSession) => Promise<T>,
  ): Promise<T> {
    if (connection.readyState !== 1 || activeTransactions >= 4)
      return deny("unavailable");
    activeTransactions++;
    const session = await connection.startSession().catch(() => {
      activeTransactions--;
      return deny("unavailable");
    });
    try {
      session.startTransaction({
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority", wtimeoutMS: 3000 },
        maxCommitTimeMS: 5000,
      });
      // Touch the authority documents in the same transaction as the receipt.
      // Concurrent disablement, ownership changes and coauthor removal then
      // conflict with this transaction instead of producing a stale consent.
      const user = (
        await connection.db.collection("users").findOneAndUpdate(
          {
            _id: new Types.ObjectId(who.accountId),
            $or: [{ status: "active" }, { status: { $exists: false } }],
          },
          { $inc: { reviewConsentRevision: 1 } },
          {
            session,
            returnDocument: "after",
            maxTimeMS: 3000,
            projection: { externalIDs: 1 },
          },
        )
      ).value;
      if (!user) return deny("forbidden");
      const githubId = user.externalIDs?.github;
      const roles: Record<string, unknown>[] = [
        { owner: new Types.ObjectId(who.accountId) },
      ];
      if (typeof githubId === "string" && /^[1-9][0-9]{0,19}$/.test(githubId))
        roles.push({ "coauthors.githubId": githubId });
      const repo = (
        await connection.db
          .collection("anonymizedrepositories")
          .findOneAndUpdate(
            { ...repository, status: "ready", $or: roles },
            { $inc: { reviewConsentRevision: 1 } },
            {
              session,
              returnDocument: "after",
              maxTimeMS: 3000,
              projection: { repoId: 1, owner: 1, options: 1 },
            },
          )
      ).value;
      if (!repo) return deny("forbidden");
      if (
        repo.options?.expirationMode !== "never" &&
        repo.options?.expirationDate &&
        (!Number.isFinite(new Date(repo.options.expirationDate).getTime()) ||
          new Date(repo.options.expirationDate).getTime() <= Date.now())
      )
        return deny("expired");
      const authority: Authority = {
        accountId: who.accountId,
        repositoryId: String(repo._id),
        repositoryName: repo.repoId,
        role: String(repo.owner) === who.accountId ? "owner" : "coauthor",
      };
      const result = await work(authority, session);
      await session.commitTransaction();
      return result;
    } catch (error) {
      if (session.inTransaction())
        await session.abortTransaction().catch(() => undefined);
      if (error instanceof ReviewConsentError) throw error;
      return deny("unavailable");
    } finally {
      activeTransactions--;
      await session.endSession().catch(() => undefined);
    }
  }
  return Object.freeze({
    async preview(
      actor: Principal,
      repositoryName: string,
      input: IntentConsumption,
      signal?: AbortSignal,
    ) {
      const who = principal(actor);
      const command = { ...input };
      if (
        typeof repositoryName !== "string" ||
        !/^[A-Za-z0-9_-]{3,128}$/.test(repositoryName)
      )
        return deny("invalid");
      const before = await transaction(
        who,
        { repoId: repositoryName },
        async (authority) => authority,
      );
      // The provider call holds no database transaction or authority lock.
      const intent = await consumer.consume(command, signal);
      const current = await transaction(
        who,
        { _id: new Types.ObjectId(before.repositoryId) },
        async (authority) => authority,
      );
      if (
        signal?.aborted ||
        Date.parse(intent.expiresAt) <= Date.now() ||
        Date.parse(intent.policy.retainUntil) <= Date.now()
      )
        return deny("expired");
      const quote: Quote = {
        version: 1,
        accountId: who.accountId,
        sessionHash: who.sessionHash,
        repositoryId: current.repositoryId,
        intent,
      };
      const body = Buffer.from(JSON.stringify(quote)).toString("base64url");
      return Object.freeze({
        ticket: body + "." + signature(body).toString("base64url"),
        repositoryName: current.repositoryName,
        policy: intent.policy,
        expiresAt: intent.expiresAt,
      });
    },
    async confirm(
      actor: Principal,
      ticket: string,
      input: {
        requestId: string;
        acceptAccess: boolean;
        acceptRetention: boolean;
      },
    ): Promise<ConsentReceipt> {
      const who = principal(actor);
      if (
        !input ||
        Object.keys(input).sort().join(",") !==
          "acceptAccess,acceptRetention,requestId" ||
        input.acceptAccess !== true ||
        input.acceptRetention !== true ||
        typeof input.requestId !== "string" ||
        !/^[a-f0-9]{32}$/.test(input.requestId)
      )
        return deny("invalid");
      const quote = decode(ticket, who),
        requestId = input.requestId;
      return transaction(
        who,
        { _id: new Types.ObjectId(quote.repositoryId) },
        async (authority, session) => {
          decode(ticket, who); // Recheck expiry after waiting for authority locks.
          const collection = connection.db.collection<SavedConsent>(
            "review_owner_consents",
          );
          const id = quote.intent.clientId + ":" + quote.intent.intentId;
          const ticketHash = hash(ticket);
          // A string _id binds each intent to at most one accepted repository and
          // session. No raw session ID, intent token or service key is persisted.
          const existing = await collection.findOne(
            { _id: id },
            { session, maxTimeMS: 3000 },
          );
          if (existing) {
            if (
              existing.ticketHash !== ticketHash ||
              existing.requestId !== requestId ||
              existing.accountId !== who.accountId ||
              existing.repositoryId !== authority.repositoryId
            )
              return deny("conflict");
            return Object.freeze(existing.receipt as ConsentReceipt);
          }
          const receipt: ConsentReceipt = Object.freeze({
            clientId: quote.intent.clientId,
            intentId: quote.intent.intentId,
            accountId: who.accountId,
            repositoryId: authority.repositoryId,
            role: authority.role,
            policy: quote.intent.policy,
            requestId,
            confirmedAt: new Date().toISOString(),
          });
          await collection.insertOne(
            {
              _id: id,
              accountId: who.accountId,
              repositoryId: authority.repositoryId,
              requestId,
              ticketHash,
              receipt,
            },
            { session, maxTimeMS: 3000 },
          );
          return receipt;
        },
      );
    },
  });
}
