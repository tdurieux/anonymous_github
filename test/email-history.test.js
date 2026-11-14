const { setImmediate } = require("node:timers");
const { expect } = require("chai");
require("ts-node/register/transpile-only");
const Users = require("../src/core/model/users/users.model").default;
const history = require("../src/core/email-history");
const admin = require("../src/server/routes/admin").default;
const { emailHistoryQuery } = require("../src/server/routes/admin-emails");

describe("email delivery history", () => {
  const restores = [];
  const stub = (obj, key, value) => { const old = obj[key]; restores.push(() => obj[key] = old); obj[key] = value; };
  let rows, updates, failWrite, failCompletion;
  const metadata = { kind: "repository-expiration", recipient: "owner@example.com", ownerId: "owner", resourceId: "repo", resourceKind: "repository" };
  beforeEach(() => {
    rows = []; updates = []; failWrite = false; failCompletion = false;
    Object.defineProperty(Users.db, "readyState", { configurable: true, value: 1 });
    restores.push(() => { delete Users.db.readyState; });
    stub(Users.db, "collection", () => ({ createIndex: async () => {},
      insertOne: async row => { if (failWrite) throw Error("database unavailable"); rows.push(row); },
      updateOne: async (filter, update) => { if (failCompletion) throw Error("database unavailable"); updates.push({ filter, update }); },
    }));
    stub(global, "fetch", async () => ({ ok: true, status: 200 }));
  });
  afterEach(() => { while (restores.length) restores.pop()(); });
  it("records recipient and outcome without retaining credentials or the message", async () => {
    await history.sendTrackedEmail(metadata, "https://api.resend.com/emails", { headers: { Authorization: "secret" }, body: "private content" });
    expect(rows).to.have.length(1);
    expect(rows[0]).to.include({ recipient: metadata.recipient, state: "sending" });
    expect(JSON.stringify(rows)).not.to.include("secret");
    expect(JSON.stringify(rows)).not.to.include("private content");
    expect(updates[0].filter._id).to.equal(rows[0]._id);
    expect(updates[0].update.$set).to.include({ state: "accepted", httpStatus: 200 });
  });
  it("starts delivery without waiting for audit storage", async () => {
    let release, started = false;
    stub(Users.db, "collection", () => ({ insertOne: () => new Promise(resolve => { release = resolve; }), updateOne: async () => {} }));
    stub(global, "fetch", async () => { started = true; return { ok: true, status: 200 }; });
    const sending = history.sendTrackedEmail(metadata, "url", {});
    expect(started).to.equal(true);
    await new Promise(resolve => setImmediate(resolve)); release(); await sending;
  });
  it("records rejection separately from an unknown outcome", async () => {
    stub(global, "fetch", async () => ({ ok: false, status: 429 }));
    await history.sendTrackedEmail(metadata, "url", {});
    expect(updates[0].update.$set).to.include({ state: "rejected", httpStatus: 429 });
    stub(global, "fetch", async () => { throw Error("timeout"); });
    try { await history.sendTrackedEmail(metadata, "url", {}); throw Error("expected failure"); }
    catch (error) { expect(error.message).to.equal("timeout"); }
    expect(updates[1].update.$set.state).to.equal("unknown");
  });
  it("keeps delivery independent of audit write failures", async () => {
    failWrite = true;
    expect((await history.sendTrackedEmail(metadata, "url", {})).ok).to.equal(true);
    failWrite = false; failCompletion = true;
    expect((await history.sendTrackedEmail(metadata, "url", {})).ok).to.equal(true);
  });
  it("validates filters and uses a stable cursor for equal timestamps", () => {
    const date = "2026-01-01T00:00:00.000Z", id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    expect(emailHistoryQuery({ state: "accepted", kind: "owner-access", before: date + "|" + id })).to.deep.equal({
      state: "accepted", kind: "owner-access", $or: [{ createdAt: { $lt: new Date(date) } }, { createdAt: new Date(date), _id: { $lt: id } }],
    });
    for (const query of [{ state: { $ne: "" } }, { kind: "invalid" }, { before: "bad" }, { before: [] }]) expect(() => emailHistoryQuery(query)).to.throw();
  });
  it("returns bounded pages with a cursor and no browser caching", async () => {
    const router = require("../src/server/routes/admin-emails").default;
    const handler = router.stack.find(layer => layer.route?.path === "/").route.stack[0].handle;
    const records = Array.from({ length: 51 }, (_, index) => ({ _id: String(index), createdAt: new Date("2026-01-01"), state: "accepted" }));
    let limit, filter, sort, result, cache;
    stub(history, "emailHistoryCollection", () => ({ find: query => {
      filter = query;
      return { sort: value => { sort = value; return { limit: count => { limit = count; return { toArray: async () => records }; } }; } };
    } }));
    await handler({ query: { state: "accepted" } }, { set: (key, value) => { cache = [key, value]; }, json: value => { result = value; } });
    expect(limit).to.equal(51); expect(sort).to.deep.equal({ createdAt: -1, _id: -1 });
    expect(filter).to.deep.equal({ state: "accepted" });
    expect(result.entries).to.have.length(50);
    expect(result.nextCursor).to.equal("2026-01-01T00:00:00.000Z|49");
    expect(cache).to.deep.equal(["Cache-Control", "no-store"]);
  });
  it("returns an explicit error for malformed queries and database failures", async () => {
    const router = require("../src/server/routes/admin-emails").default;
    const handler = router.stack.find(layer => layer.route?.path === "/").route.stack[0].handle;
    let code, body;
    const res = { set() {}, status(value) { code = value; return this; }, json(value) { body = value; } };
    await handler({ query: { before: "broken" } }, res);
    expect(code).to.equal(400);
    stub(history, "emailHistoryCollection", () => { throw Error("private database info"); });
    await handler({ query: {} }, res);
    expect(code).to.equal(503); expect(body.error).not.to.include("private");
  });
  it("mounts history behind authentication and administrator checks", () => {
    const emails = require("../src/server/routes/admin-emails").default;
    const index = admin.stack.findIndex(layer => layer.handle === emails);
    expect(index).to.be.greaterThan(1);
    expect(admin.stack.slice(0, index).filter(layer => !layer.route && layer.handle.length >= 3).length).to.be.at.least(2);
  });
});
