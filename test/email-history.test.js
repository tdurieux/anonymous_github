const { setImmediate } = require("node:timers");
const { expect } = require("chai");
require("ts-node/register/transpile-only");
const Users = require("../src/core/model/users/users.model").default;
const history = require("../src/core/email-history");
const admin = require("../src/server/routes/admin").default;
const { emailHistoryQuery, emailHistoryPeriod, emailHistorySummary } = require("../src/server/routes/admin-emails");

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
    let limit, filter, sort, result, cache, options;
    stub(history, "emailHistoryCollection", () => ({ find: (query, value) => {
      filter = query; options = value;
      return { sort: value => { sort = value; return { limit: count => { limit = count; return { toArray: async () => records }; } }; } };
    } }));
    await handler({ query: { state: "accepted" } }, { set: (key, value) => { cache = [key, value]; }, json: value => { result = value; } });
    expect(options.maxTimeMS).to.equal(5000);
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
  it("uses UTC calendar periods and rejects malformed period or search input", () => {
    const now = new Date("2026-11-14T23:59:00.000Z");
    expect(emailHistoryPeriod("7d", now)).to.deep.equal({ period: "7d", chartDays: 7, start: new Date("2026-11-08T00:00:00.000Z") });
    expect(emailHistoryQuery({ period: "30d" }, now).createdAt.$gte.toISOString()).to.equal("2026-10-16T00:00:00.000Z");
    expect(emailHistoryQuery({ period: "all" }, now)).to.deep.equal({});
    expect(emailHistoryQuery({}, now)).to.deep.equal({});
    for (const query of [{ period: "1d" }, { period: [] }, { period: "" }, { search: [] }, { search: { $ne: "" } }, { search: "a".repeat(201) }]) {
      expect(() => emailHistoryQuery(query)).to.throw();
    }
  });
  it("searches literal recipient text and exact IDs without losing the cursor or period", () => {
    const now = new Date("2026-11-14T12:00:00.000Z");
    const before = "2026-11-12T12:00:00.000Z|aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const query = emailHistoryQuery({ search: "  a+b.[test]@example.com  ", before, period: "7d" }, now);
    const regex = new RegExp(query.$or[0].recipient.$regex, query.$or[0].recipient.$options);
    expect(regex.test("A+B.[test]@example.com")).to.equal(true);
    expect(regex.test("abxt@example.com")).to.equal(false);
    expect(query.$or.slice(1)).to.deep.equal([{ _id: "a+b.[test]@example.com" }, { ownerId: "a+b.[test]@example.com" }, { resourceId: "a+b.[test]@example.com" }]);
    expect(query.$and[0].$or).to.have.length(2);
    expect(query.createdAt.$gte.toISOString()).to.equal("2026-11-08T00:00:00.000Z");
    expect(emailHistoryQuery({ search: "   " })).to.deep.equal({});
  });
  it("zero fills UTC daily series and keeps all-time totals independent of the chart", () => {
    const period = emailHistoryPeriod("all", new Date("2026-11-14T12:00:00.000Z"));
    const result = emailHistorySummary([{ _id: "accepted", count: 75 }, { _id: "unknown", count: 3 }], [
      { _id: { date: "2026-11-14", state: "accepted" }, count: 2 },
      { _id: { date: "2025-01-01", state: "accepted" }, count: 50 },
    ], period);
    expect(result.total).to.equal(78);
    expect(result.counts).to.deep.equal({ accepted: 75, rejected: 0, unknown: 3, sending: 0 });
    expect(result.series).to.have.length(30);
    expect(result.series[0]).to.deep.equal({ date: "2026-10-16", accepted: 0, rejected: 0, unknown: 0, sending: 0 });
    expect(result.series.at(-1).accepted).to.equal(2);
    expect(result.chartDays).to.equal(30);
    expect(result.period).to.equal("all");
  });
  it("aggregates the whole filtered dataset independently of state and cursor with bounded database time", async () => {
    const router = require("../src/server/routes/admin-emails").default;
    const handler = router.stack.find(layer => layer.route?.path === "/summary").route.stack[0].handle;
    let pipeline, options, result, cache;
    stub(history, "emailHistoryCollection", () => ({ aggregate: (stages, opts) => {
      pipeline = stages; options = opts;
      return { toArray: async () => [{ counts: [{ _id: "accepted", count: 120 }, { _id: "rejected", count: 8 }], daily: [] }] };
    } }));
    await handler({ query: { state: "rejected", before: "ignored", period: "7d", kind: "owner-access", search: "research" } }, {
      set: (key, value) => { cache = [key, value]; }, json: value => { result = value; },
    });
    expect(pipeline[0].$match).not.to.have.property("state");
    expect(pipeline[0].$match).not.to.have.property("$and");
    expect(pipeline[0].$match.kind).to.equal("owner-access");
    expect(pipeline[0].$match.$or[0].recipient.$regex).to.equal("research");
    expect(pipeline[1].$facet.daily[1].$group._id.date.$dateToString.timezone).to.equal("UTC");
    expect(options.maxTimeMS).to.equal(5000);
    expect(result.total).to.equal(128);
    expect(result.series).to.have.length(7);
    expect(cache).to.deep.equal(["Cache-Control", "no-store"]);
  });
  it("reports invalid summary filters and aggregate failures without exposing database errors", async () => {
    const router = require("../src/server/routes/admin-emails").default;
    const handler = router.stack.find(layer => layer.route?.path === "/summary").route.stack[0].handle;
    let code, body;
    const res = { set() {}, status(value) { code = value; return this; }, json(value) { body = value; } };
    await handler({ query: { period: "wrong" } }, res);
    expect(code).to.equal(400);
    stub(history, "emailHistoryCollection", () => ({ aggregate: () => ({ toArray: async () => { throw Error("private timeout info"); } }) }));
    await handler({ query: {} }, res);
    expect(code).to.equal(503);
    expect(body.error).not.to.include("private");
  });
  it("mounts history behind authentication and administrator checks", () => {
    const emails = require("../src/server/routes/admin-emails").default;
    const index = admin.stack.findIndex(layer => layer.handle === emails);
    expect(index).to.be.greaterThan(1);
    expect(admin.stack.slice(0, index).filter(layer => !layer.route && layer.handle.length >= 3).length).to.be.at.least(2);
  });
});
