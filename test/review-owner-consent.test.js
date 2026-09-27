require("ts-node/register/transpile-only");
const { expect } = require("chai");
const mongoose = require("mongoose");
const { randomBytes } = require("crypto");
const process = require("process");
const {
  createReviewOwnerConsent,
} = require("../src/server/service/review-owner-consent");
const actorId = new mongoose.Types.ObjectId();
const coauthorId = new mongoose.Types.ObjectId();
const otherId = new mongoose.Types.ObjectId();
const repoId = new mongoose.Types.ObjectId();
const actor = (accountId = actorId, sessionId = "s".repeat(32)) => ({
  accountId: String(accountId),
  sessionId,
});
const request = () => ({
  contract: "4open.artifacts/1",
  clientId: "1".repeat(32),
  intentId: "2".repeat(32),
  token: "3".repeat(64),
  requestId: "4".repeat(32),
});
const intent = () => ({
  contract: "4open.artifacts/1",
  clientId: "1".repeat(32),
  intentId: "2".repeat(32),
  submissionRef: "5".repeat(32),
  callbackId: "6".repeat(32),
  entitlementId: "7".repeat(32),
  expiresAt: new Date(Date.now() + 120000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z"),
  policy: {
    version: 1,
    access: "restricted-review",
    retainUntil: "2099-01-01T00:00:00Z",
  },
});
const confirmation = () => ({
  requestId: "8".repeat(32),
  acceptAccess: true,
  acceptRetention: true,
});
async function rejected(promise, kind) {
  try {
    await promise;
    expect.fail("operation unexpectedly succeeded");
  } catch (error) {
    expect(error.kind).to.equal(kind);
    expect(error.message).to.equal("Review owner consent " + kind);
  }
}

describe("review owner consent transactions", function () {
  this.timeout(15000);
  let connection, store, calls, upstream;
  const key = randomBytes(32);
  before(async function () {
    if (!process.env.TEST_REVIEW_CONSENT_MONGO) this.skip();
    connection = await mongoose
      .createConnection(process.env.TEST_REVIEW_CONSENT_MONGO, {
        dbName: "review_consent_test_" + randomBytes(8).toString("hex"),
        serverSelectionTimeoutMS: 3000,
        socketTimeoutMS: 10000,
        monitorCommands: true,
        autoIndex: false,
        autoCreate: false,
        maxPoolSize: 10,
      })
      .asPromise();
    await connection.db.createCollection("review_owner_consents");
  });
  after(async () => {
    if (connection) {
      await connection.dropDatabase();
      await connection.close();
    }
  });
  beforeEach(async () => {
    await Promise.all(
      ["users", "anonymizedrepositories", "review_owner_consents"].map((name) =>
        connection.db.collection(name).deleteMany({}),
      ),
    );
    await connection.db.collection("users").insertMany([
      {
        _id: actorId,
        username: "owner",
        externalIDs: { github: "101" },
        status: "active",
      },
      {
        _id: coauthorId,
        username: "coauthor",
        externalIDs: { github: "102" },
        status: "active",
      },
      {
        _id: otherId,
        username: "other",
        externalIDs: { github: "103" },
        isAdmin: true,
        status: "active",
      },
    ]);
    await connection.db.collection("anonymizedrepositories").insertOne({
      _id: repoId,
      repoId: "synthetic-repository",
      owner: actorId,
      status: "ready",
      coauthors: [{ username: "coauthor", githubId: "102" }],
      options: { expirationMode: "never" },
    });
    calls = 0;
    upstream = async () => intent();
    store = createReviewOwnerConsent(
      connection,
      {
        consume: async (...args) => {
          calls++;
          return upstream(...args);
        },
      },
      key,
    );
  });
  it("requires explicit policy acceptance and retains one immutable receipt on retries", async () => {
    const preview = await store.preview(
      actor(),
      "synthetic-repository",
      request(),
    );
    expect(preview.policy).to.deep.equal(intent().policy);
    expect(preview.repositoryName).to.equal("synthetic-repository");
    expect(calls).to.equal(1);
    for (const patch of [
      { acceptAccess: false },
      { acceptRetention: false },
      { acceptAccess: "true" },
      { policy: {} },
    ])
      await rejected(
        store.confirm(actor(), preview.ticket, { ...confirmation(), ...patch }),
        "invalid",
      );
    const first = await store.confirm(actor(), preview.ticket, confirmation());
    expect(first.role).to.equal("owner");
    expect(first.policy).to.deep.equal(preview.policy);
    const replay = await store.confirm(actor(), preview.ticket, confirmation());
    expect(replay).to.deep.equal(first);
    await rejected(
      store.confirm(actor(), preview.ticket, {
        ...confirmation(),
        requestId: "9".repeat(32),
      }),
      "conflict",
    );
    const rows = await connection.db
      .collection("review_owner_consents")
      .find({})
      .toArray();
    expect(rows).to.have.length(1);
    const stored = JSON.stringify(rows);
    for (const secret of [actor().sessionId, request().token, preview.ticket])
      expect(stored).not.to.include(secret);
    expect(calls).to.equal(1);
  });
  it("accepts a stable-ID coauthor but never an unrelated administrator or matching legacy username", async () => {
    const quote = await store.preview(
      actor(coauthorId),
      "synthetic-repository",
      request(),
    );
    expect(
      (await store.confirm(actor(coauthorId), quote.ticket, confirmation()))
        .role,
    ).to.equal("coauthor");
    await rejected(
      store.preview(actor(otherId), "synthetic-repository", request()),
      "forbidden",
    );
    await connection.db
      .collection("anonymizedrepositories")
      .updateOne(
        { _id: repoId },
        { $set: { coauthors: [{ username: "coauthor" }] } },
      );
    await rejected(
      store.preview(actor(coauthorId), "synthetic-repository", request()),
      "forbidden",
    );
    expect(calls).to.equal(1);
  });
  it("binds signed previews to the account, session and exact policy", async () => {
    const preview = await store.preview(
      actor(),
      "synthetic-repository",
      request(),
    );
    await rejected(
      store.confirm(actor(otherId), preview.ticket, confirmation()),
      "forbidden",
    );
    await rejected(
      store.confirm(
        actor(actorId, "n".repeat(32)),
        preview.ticket,
        confirmation(),
      ),
      "forbidden",
    );
    const [body, signature] = preview.ticket.split(".");
    const modified = JSON.parse(Buffer.from(body, "base64url").toString());
    modified.intent.policy.access = "anonymous-link";
    await rejected(
      store.confirm(
        actor(),
        Buffer.from(JSON.stringify(modified)).toString("base64url") +
          "." +
          signature,
        confirmation(),
      ),
      "invalid",
    );
    await rejected(
      store.confirm(actor(), "x".repeat(8193), confirmation()),
      "invalid",
    );
    expect(
      await connection.db.collection("review_owner_consents").countDocuments(),
    ).to.equal(0);
  });
  it("rechecks owner status and revocation when confirming or replaying", async () => {
    const quote = await store.preview(
      actor(),
      "synthetic-repository",
      request(),
    );
    await store.confirm(actor(), quote.ticket, confirmation());
    await connection.db
      .collection("users")
      .updateOne({ _id: actorId }, { $set: { status: "banned" } });
    await rejected(
      store.confirm(actor(), quote.ticket, confirmation()),
      "forbidden",
    );
    await connection.db
      .collection("users")
      .updateOne({ _id: actorId }, { $set: { status: "active" } });
    await connection.db
      .collection("anonymizedrepositories")
      .updateOne({ _id: repoId }, { $set: { owner: otherId } });
    await rejected(
      store.confirm(actor(), quote.ticket, confirmation()),
      "forbidden",
    );
    expect(
      await connection.db.collection("review_owner_consents").countDocuments(),
    ).to.equal(1);
  });
  it("rejects removed coauthors and archived or expired repositories", async () => {
    const quote = await store.preview(
      actor(coauthorId),
      "synthetic-repository",
      request(),
    );
    await connection.db
      .collection("anonymizedrepositories")
      .updateOne({ _id: repoId }, { $set: { coauthors: [] } });
    await rejected(
      store.confirm(actor(coauthorId), quote.ticket, confirmation()),
      "forbidden",
    );
    await connection.db
      .collection("anonymizedrepositories")
      .updateOne({ _id: repoId }, { $set: { status: "archived" } });
    await rejected(
      store.preview(actor(), "synthetic-repository", request()),
      "forbidden",
    );
    await connection.db.collection("anonymizedrepositories").updateOne(
      { _id: repoId },
      {
        $set: {
          status: "ready",
          options: { expirationMode: "remove", expirationDate: new Date(0) },
        },
      },
    );
    await rejected(
      store.preview(actor(), "synthetic-repository", request()),
      "expired",
    );
    expect(calls).to.equal(1);
  });
  it("does not hold database authority locks across the upstream request and checks removal afterward", async () => {
    let ready, release;
    const arrived = new Promise((resolve) => {
      ready = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    upstream = async () => {
      ready();
      await gate;
      return intent();
    };
    const pending = store.preview(
      actor(coauthorId),
      "synthetic-repository",
      request(),
    );
    await arrived;
    try {
      await connection.db
        .collection("anonymizedrepositories")
        .updateOne(
          { _id: repoId },
          { $set: { coauthors: [] } },
          { maxTimeMS: 1000 },
        );
    } finally {
      release();
    }
    await rejected(pending, "forbidden");
    expect(
      await connection.db.collection("review_owner_consents").countDocuments(),
    ).to.equal(0);
  });
  it("keeps one receipt across concurrent confirmations and permits explicit recovery", async () => {
    const quote = await store.preview(
      actor(),
      "synthetic-repository",
      request(),
    );
    const results = await Promise.allSettled([
      store.confirm(actor(), quote.ticket, confirmation()),
      store.confirm(actor(), quote.ticket, confirmation()),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).to.equal(true);
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason.kind).to.equal("unavailable");
    const retry = await store.confirm(actor(), quote.ticket, confirmation());
    for (const result of results)
      if (result.status === "fulfilled")
        expect(result.value).to.deep.equal(retry);
    expect(
      await connection.db.collection("review_owner_consents").countDocuments(),
    ).to.equal(1);
  });
  it("rejects expired previews without recording consent", async () => {
    upstream = async () => ({
      ...intent(),
      expiresAt: new Date(Date.now() + 2000).toISOString(),
    });
    const quote = await store.preview(
      actor(),
      "synthetic-repository",
      request(),
    );
    const { setTimeout } = require("timers/promises");
    await setTimeout(2100);
    await rejected(
      store.confirm(actor(), quote.ticket, confirmation()),
      "expired",
    );
    expect(
      await connection.db.collection("review_owner_consents").countDocuments(),
    ).to.equal(0);
  });
  it("cannot confirm a quote for a second repository under the same intent", async () => {
    const first = await store.preview(
      actor(),
      "synthetic-repository",
      request(),
    );
    await store.confirm(actor(), first.ticket, confirmation());
    await connection.db.collection("anonymizedrepositories").insertOne({
      repoId: "second-repository",
      owner: actorId,
      status: "ready",
      options: { expirationMode: "never" },
    });
    const second = await store.preview(actor(), "second-repository", request());
    await rejected(
      store.confirm(actor(), second.ticket, confirmation()),
      "conflict",
    );
    expect(
      await connection.db.collection("review_owner_consents").countDocuments(),
    ).to.equal(1);
  });
  it("conflicts with a concurrent ownership change and rejects its explicit retry", async () => {
    const quote = await store.preview(
      actor(),
      "synthetic-repository",
      request(),
    );
    const session = await connection.startSession();
    session.startTransaction();
    await connection.db
      .collection("anonymizedrepositories")
      .updateOne({ _id: repoId }, { $set: { owner: otherId } }, { session });
    let arrived;
    const ready = new Promise((resolve) => {
      arrived = resolve;
    });
    const listener = (event) => {
      if (
        event.commandName === "findAndModify" &&
        event.command.findAndModify === "anonymizedrepositories"
      )
        arrived();
    };
    connection.getClient().on("commandStarted", listener);
    const pending = store.confirm(actor(), quote.ticket, confirmation()).then(
      () => "ok",
      (error) => error.kind,
    );
    try {
      await ready;
      await session.commitTransaction();
      expect(await pending).to.equal("unavailable");
      await rejected(
        store.confirm(actor(), quote.ticket, confirmation()),
        "forbidden",
      );
      expect(
        await connection.db
          .collection("review_owner_consents")
          .countDocuments(),
      ).to.equal(0);
    } finally {
      connection.getClient().off("commandStarted", listener);
      if (session.inTransaction()) await session.abortTransaction();
      await session.endSession();
    }
  });
  it("keeps authority serialization fields out of ordinary user and repository reads", async () => {
    await store.preview(actor(), "synthetic-repository", request());
    const users = connection.model(
      "ConsentPrivacyUser",
      require("../src/core/model/users/users.schema").default,
      "users",
    );
    const repos = connection.model(
      "ConsentPrivacyRepo",
      require("../src/core/model/anonymizedRepositories/anonymizedRepositories.schema")
        .default,
      "anonymizedrepositories",
    );
    expect(
      (await users.findById(actorId).lean()).reviewConsentRevision,
    ).to.equal(undefined);
    expect(
      (await repos.findById(repoId).lean()).reviewConsentRevision,
    ).to.equal(undefined);
    expect(
      (await connection.db.collection("users").findOne({ _id: actorId }))
        .reviewConsentRevision,
    ).to.equal(2);
    expect(
      (
        await connection.db
          .collection("anonymizedrepositories")
          .findOne({ _id: repoId })
      ).reviewConsentRevision,
    ).to.equal(2);
  });
  it("measures durable receipt replay when explicitly requested", async function () {
    if (!process.env.TEST_REVIEW_CONSENT_PERF_REPORT) this.skip();
    const quote = await store.preview(
      actor(),
      "synthetic-repository",
      request(),
    );
    const original = await store.confirm(actor(), quote.ticket, confirmation());
    const times = [];
    for (let n = 0; n < 100; n++) {
      const start = process.hrtime.bigint();
      expect(
        await store.confirm(actor(), quote.ticket, confirmation()),
      ).to.deep.equal(original);
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    times.sort((a, b) => a - b);
    expect(
      await connection.db.collection("review_owner_consents").countDocuments(),
    ).to.equal(1);
    require("fs").writeFileSync(
      process.env.TEST_REVIEW_CONSENT_PERF_REPORT,
      JSON.stringify(
        {
          calls: times.length,
          database: "disposable loopback MongoDB replica set",
          synthetic: true,
          meanMs: times.reduce((a, b) => a + b, 0) / times.length,
          medianMs: times[50],
          p95Ms: times[94],
        },
        null,
        2,
      ) + "\n",
    );
  });
});
