const { expect } = require("chai");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../public/script/admin.js"), "utf8");
const script = source.slice(source.indexOf("export const emailsAdminController")).replace("export const", "const") + ";this.controller = emailsAdminController;";
const sandbox = { console, Date, Intl }; vm.runInNewContext(script, sandbox);
const tick = () => new Promise(resolve => require("node:timers").setImmediate(resolve));

describe("email admin UI requests", () => {
  let state, pending;
  beforeEach(() => {
    pending = [];
    state = { user: {}, on() {} };
    sandbox.controller(state, { get: (url, options) => new Promise((resolve, reject) => pending.push({ url, options, resolve, reject })) }, { url() {} });
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
    pending[1].resolve(response([])); await clear;
  });
});
