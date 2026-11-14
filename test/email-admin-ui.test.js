const { URL, URLSearchParams } = require("node:url");
const { expect } = require("chai");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../public/script/admin.js"), "utf8");
const script = source.slice(source.indexOf("export const emailsAdminController")).replace("export const", "const") + ";this.controller = emailsAdminController;";
const sandbox = { console, Date, Intl }; vm.runInNewContext(script, sandbox);
const tick = () => new Promise(resolve => require("node:timers").setImmediate(resolve));

describe("email admin UI requests", () => {
  let state, pending, summaries, dispose;
  beforeEach(() => {
    pending = []; summaries = [];
    state = { user: {}, on(event, callback) { if (event === "dispose") dispose = callback; } };
    sandbox.controller(state, { get: (url, options) => new Promise((resolve, reject) => (url.endsWith("/summary") ? summaries : pending).push({ url, options, resolve, reject })) }, { url() {} });
  });
  const response = (entries, nextCursor = null) => ({ data: { entries, nextCursor } });
  it("keeps visible history when a refresh fails", async () => {
    pending[0].resolve(response([{ _id: "first" }])); await tick();
    const refresh = state.loadEmails();
    expect(state.emailRows).to.have.length(1);
    pending[1].reject(Error("offline")); await refresh;
    expect(state.emailRows[0]._id).to.equal("first"); expect(state.emailError).not.to.equal("");
  });
  it("retries the failed older page without discarding previous rows", async () => {
    pending[0].resolve(response([{ _id: "first" }], "cursor")); await tick();
    const more = state.loadEmails(true); pending[1].reject(Error("offline")); await more;
    const retry = state.retryEmails();
    expect(pending[2].options.params.before).to.equal("cursor");
    pending[2].resolve(response([{ _id: "second" }])); await retry;
    expect(state.emailRows.map(row => row._id)).to.deep.equal(["first", "second"]);
  });
  it("clears rows on filter changes and ignores stale responses", async () => {
    pending[0].resolve(response([{ _id: "first" }])); await tick();
    const old = state.loadEmails();
    state.emailState = "rejected";
    const current = state.loadEmails();
    expect(state.emailRows).to.have.length(0);
    pending[2].resolve(response([{ _id: "rejected" }])); await current;
    pending[1].resolve(response([{ _id: "stale" }])); await old;
    expect(state.emailRows[0]._id).to.equal("rejected");
  });
  it("exposes whether filters are active and clears them in one action", async () => {
    pending[0].resolve(response([])); await tick();
    state.emailKind = "owner-access"; expect(state.hasEmailFilters()).to.equal(true);
    const clear = state.clearEmailFilters();
    expect(state.hasEmailFilters()).to.equal(false);
    pending[1].resolve(response([])); summaries[1].resolve({ data: { counts: {}, total: 0, series: [] } }); await clear;
  });
  it("loads bounded pages and fetches older history only at the loaded boundary", async () => {
    pending[0].resolve(response(Array.from({ length: 50 }, (_, i) => ({ _id: String(i) })), "older")); await tick();
    expect(state.emailVisibleRows()).to.have.length(25);
    await state.emailNextPage(); expect(state.emailPage).to.equal(2); expect(pending).to.have.length(1);
    const next = state.emailNextPage();
    expect(pending[1].options.params.before).to.equal("older");
    pending[1].resolve(response([{ _id: "50" }])); await next;
    expect(state.emailPage).to.equal(3); expect(state.emailVisibleRows()[0]._id).to.equal("50");
    state.emailPreviousPage(); expect(state.emailVisibleRows()).to.have.length(25);
  });
  it("does not turn unavailable summary data into zero counts", async () => {
    summaries[0].reject(Error("offline")); await tick();
    expect(state.emailTotal()).to.equal(null); expect(state.emailPageCount()).to.equal(null);
    expect(state.emailSummaryError).not.to.equal("");
  });
  it("ignores stale summary responses and applies search only on submit", async () => {
    state.emailSearch = " author@example.com ";
    expect(pending[0].options.params.search).to.equal(undefined);
    const current = state.applyEmailFilters();
    expect(pending[1].options.params.search).to.equal("author@example.com");
    expect(summaries[1].options.params.state).to.equal(undefined);
    pending[1].resolve(response([])); summaries[1].resolve({ data: { counts: { rejected: 3 }, total: 3, series: [] } }); await current;
    summaries[0].resolve({ data: { counts: {}, total: 99, series: [] } }); await tick();
    expect(state.emailTotal()).to.equal(3);
    const status = state.setEmailStatus("rejected"); expect(summaries).to.have.length(2);
    pending[2].resolve(response([])); await status; expect(state.emailTotal()).to.equal(3);
  });
  it("ignores responses after disposal", async () => {
    dispose(); pending[0].resolve(response([{ _id: "late" }]));
    summaries[0].resolve({ data: { total: 99 } }); await tick();
    expect(state.emailRows).to.have.length(0); expect(state.emailSummary).to.equal(null);
  });
  it("retains summary totals and the current page when requests fail", async () => {
    pending[0].resolve(response(Array.from({ length: 25 }, (_, i) => ({ _id: String(i) })), "older"));
    summaries[0].resolve({ data: { counts: { accepted: 30 }, total: 30, series: [] } }); await tick();
    const next = state.emailNextPage(); pending[1].reject(Error("offline")); await next;
    expect(state.emailPage).to.equal(1); expect(state.emailVisibleRows()).to.have.length(25);
    const summary = state.loadEmailSummary(); summaries[1].reject(Error("offline")); await summary;
    expect(state.emailTotal()).to.equal(30); expect(state.emailSummaryError).to.include("Previously loaded");
  });
  it("restores valid URL filters and preserves unrelated URL state", async () => {
    let saved;
    const local = { console, Date, Intl, URL, URLSearchParams, window: {
      location: { search: "?state=rejected&period=30d&search=author%40example.com&other=keep", href: "http://localhost/admin/emails?state=rejected&period=30d&search=author%40example.com&other=keep#history" },
      history: { replaceState(a, b, value) { saved = value; } },
    } };
    vm.runInNewContext(script, local);
    const restored = { user: {}, on() {} };
    local.controller(restored, { get: () => new Promise(() => {}) }, { url() {} });
    expect(restored.emailState).to.equal("rejected"); expect(restored.emailPeriod).to.equal("30d");
    expect(restored.emailSearch).to.equal("author@example.com");
    expect(saved).to.include("other=keep"); expect(saved).to.include("#history");
  });
  it("advances to the intended page after retrying a failed Next", async () => {
    pending[0].resolve(response(Array.from({ length: 25 }, (_, i) => ({ _id: String(i) })), "older")); await tick();
    const next = state.emailNextPage(); pending[1].reject(Error("offline")); await next;
    expect(state.emailPage).to.equal(1);
    const retry = state.retryEmails(); pending[2].resolve(response([{ _id: "next" }])); await retry;
    expect(state.emailPage).to.equal(2); expect(state.emailVisibleRows()[0]._id).to.equal("next");
    expect(state.emailAnnouncement).to.equal("Page 2. Showing attempts 26 to 26.");
    state.emailPreviousPage(); expect(state.emailAnnouncement).to.equal("Page 1. Showing attempts 1 to 25.");
    await state.emailNextPage(); expect(state.emailAnnouncement).to.equal("Page 2. Showing attempts 26 to 26.");
  });
  it("resets a failed page target on filter changes", async () => {
    pending[0].resolve(response(Array.from({ length: 25 }, (_, i) => ({ _id: String(i) })), "older")); await tick();
    const next = state.emailNextPage(); pending[1].reject(Error("offline")); await next;
    const filtered = state.setEmailStatus("rejected"); pending[2].resolve(response([{ _id: "filtered" }], "filteredOlder")); await filtered;
    const more = state.loadEmails(true); pending[3].resolve(response(Array.from({ length: 25 }, (_, i) => ({ _id: "extra" + i })))); await more;
    expect(state.emailPage).to.equal(1);
  });
  it("handles empty chart date endpoints", () => {
    expect(state.emailDayLabel(undefined)).to.equal(""); expect(state.emailDayLabel({})).to.equal("");
    expect(state.emailDayLabel({ date: "not-a-date" })).to.equal("");
    expect(state.emailDayLabel({ date: "2026-11-14" })).not.to.equal("");
  });
  it("focuses and scrolls the history heading only on explicit paging", async () => {
    let focused = 0, scrolled = 0;
    const heading = { setAttribute(key, value) { expect([key, value]).to.deep.equal(["tabindex", "-1"]); }, focus(options) { expect(options.preventScroll).to.equal(true); focused++; }, scrollIntoView() { scrolled++; } };
    const local = { console, Date, Intl, URL, URLSearchParams, window: {
      location: { search: "", href: "http://localhost/admin/emails" }, history: { replaceState() {} },
      document: { querySelector(selector) { return selector === "#email-history-title" ? heading : null; } },
    } };
    vm.runInNewContext(script, local);
    const view = { user: {}, on() {} };
    local.controller(view, { get: url => Promise.resolve(url.endsWith("/summary") ? { data: { counts: {}, total: 50, series: [] } } : response(Array.from({ length: 50 }, (_, i) => ({ _id: String(i) })))) }, { url() {} });
    await tick(); expect(focused).to.equal(0);
    await view.emailNextPage(); expect(focused).to.equal(1); expect(scrolled).to.equal(1);
    await view.refreshEmails(); expect(focused).to.equal(1);
  });
  it("shows years for older dates and all-time history", () => {
    const currentYear = new Date().getFullYear();
    expect(state.emailShortTime(`${currentYear - 1}-06-01T12:00:00Z`)).to.include(String(currentYear - 1));
    state.emailPeriod = "all";
    expect(state.emailShortTime(`${currentYear}-06-01T12:00:00Z`)).to.include(String(currentYear));
  });
  it("explains outcomes without inventing delivery evidence", () => {
    expect(state.emailExplanation({ state: "accepted" })).to.include("not confirmed");
    expect(state.emailExplanation({ state: "rejected", httpStatus: 429 })).to.include("rate limiting");
    expect(state.emailExplanation({ state: "unknown" })).to.include("avoid duplicates");
  });
  it("uses displayed chart activity independently of all-time totals", () => {
    state.emailSummary = {total: 100, series: [{date: "2026-11-14", accepted: 0, rejected: 0, unknown: 0, sending: 0}]};
    expect(state.emailChartTotal()).to.equal(0);
    state.emailSummary.series[0].unknown = 3;
    expect(state.emailChartTotal()).to.equal(3);
  });

});
