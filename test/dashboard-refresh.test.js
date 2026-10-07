const { expect } = require("chai");
const fs = require("fs");
const vm = require("vm");
const { setImmediate } = require("timers");
const source = fs.readFileSync(require("path").join(__dirname, "../public/script/app.js"), "utf8");
const actions = source.slice(source.indexOf("      function waitRepoToBeReady("), source.indexOf("      state.itemFilter ="));

describe("dashboard refresh feedback", () => {
  async function run({ statuses = [], postError, getError } = {}) {
    let toast;
    const item = { _type: "repo", _id: "restore-me", repoId: "restore-me", status: "removed" };
    const state = { items: [item], addToast: value => { toast = value; } };
    const pending = [];
    let reloads = 0;
    vm.runInNewContext(actions, {
      state, reactive: value => value,
      statusKey: status => ["ready", "error", "removed", "expired"].includes(status) ? status : "progress",
      http: {
        post: async () => { if (postError) throw postError; return {}; },
        get: async () => { if (getError) throw getError; return { data: statuses.shift() }; },
      },
      timers: { timeout: callback => pending.push(callback) },
      loadAll: () => { reloads++; },
    });
    state.refreshItem(item);
    await new Promise(resolve => setImmediate(resolve));
    while (pending.length) {
      pending.shift()();
      await new Promise(resolve => setImmediate(resolve));
    }
    return { toast, item, reloads };
  }

  it("reports success after preparation reaches ready", async () => {
    const result = await run({ statuses: [{ status: "preparing" }, { status: "ready" }] });
    expect(result.toast.title).to.equal("restore-me is refreshed.");
    expect(result.item.status).to.equal("ready");
    expect(result.reloads).to.equal(0);
  });
  for (const status of ["error", "removed", "expired"]) {
    it(`reports ${status} as a failed refresh`, async () => {
      const result = await run({ statuses: [{ status, statusMessage: "token_expired" }] });
      expect(result.toast.title).to.equal("Error during the refresh of restore-me.");
      expect(result.toast.body).to.equal("token_expired");
      expect(result.item.statusMessage).to.equal("token_expired");
      expect(result.reloads).to.equal(1);
    });
  }
  it("explains a terminal status without a status message", async () => {
    const result = await run({ statuses: [{ status: "expired" }] });
    expect(result.toast.body).to.equal("The repository is expired.");
  });
  for (const stage of ["postError", "getError"]) {
    it(`shows the API error from ${stage}`, async () => {
      const result = await run({ [stage]: { data: { error: "not_connected" } } });
      expect(result.toast.title).to.equal("Error during the refresh of restore-me.");
      expect(result.toast.body).to.equal("not_connected");
    });
  }
  it("reports a polling network failure", async () => {
    const result = await run({ getError: new Error("Network failure") });
    expect(result.toast.title).to.equal("Error during the refresh of restore-me.");
    expect(result.toast.body).to.include("Please try again");
  });
});
