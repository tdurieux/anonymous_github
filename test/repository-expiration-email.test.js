const { expect } = require("chai");
require("ts-node/register/transpile-only");
const config = require("../src/config").default;
const Repo = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const Users = require("../src/core/model/users/users.model").default;
const { notifyRepositoryExpired } = require("../src/core/repository-expiration-email");

describe("repository expiration email", function () {
  const restores = [];
  const stub = (object, key, value) => { const old = object[key]; restores.push(() => object[key] = old); object[key] = value; };
  let repo, owner, calls, claims, claimedFor;
  beforeEach(() => {
    repo = { _id: "repo-object-id", repoId: "anonymous-name", owner: "owner-id", statusDate: new Date(),
      options: { expirationMode: "remove", expirationDate: new Date("2025-01-01") } };
    owner = { emails: [{ email: "default@example.com", default: true }], notificationEmail: "preferred@example.com" };
    calls = []; claims = []; claimedFor = undefined;
    stub(config, "RESEND_API_KEY", "test-key"); stub(config, "EMAIL_FROM", "alerts@example.com");
    stub(config, "APP_HOSTNAME", "https://anonymous.example.com");
    stub(Repo, "findOne", filter => {
      expect(filter.status).to.equal("expired");
      return { lean: async () => repo };
    });
    stub(Users, "findOne", filter => {
      expect(filter.status.$nin).to.deep.equal(["removed", "banned"]);
      return { lean: async () => owner };
    });
    stub(Repo, "updateOne", (filter, update) => ({ exec: async () => {
      claims.push(filter);
      const date = update.$set.expirationEmailClaimedFor.getTime();
      if (claimedFor === date) return { matchedCount: 0 };
      claimedFor = date;
      return { matchedCount: 1 };
    } }));
    stub(global, "fetch", async (url, options) => { calls.push({ url, options }); return { ok: true }; });
  });
  afterEach(() => { while (restores.length) restores.pop()(); });

  it("sends the preferred address an expiration notice with a dashboard link", async () => {
    await notifyRepositoryExpired(repo._id);
    const body = JSON.parse(calls[0].options.body);
    expect(body.to).to.deep.equal(["preferred@example.com"]);
    expect(body.text).to.include('"anonymous-name" expired on 2025-01-01');
    expect(body.text).to.include("https://anonymous.example.com/dashboard");
    expect(body.text).not.to.include("redirects");
    expect(claims[0]).to.include({ owner: repo.owner, status: "expired", statusDate: repo.statusDate });
    expect(claims[0]["options.expirationDate"]).to.equal(repo.options.expirationDate);
  });
  it("explains redirect expiration", async () => {
    repo.options.expirationMode = "redirect";
    await notifyRepositoryExpired(repo._id);
    expect(JSON.parse(calls[0].options.body).text).to.include("redirects to the original repository");
  });
  it("claims concurrent notifications once, and allows a later expiration date", async () => {
    await Promise.all([notifyRepositoryExpired(repo._id), notifyRepositoryExpired(repo._id)]);
    expect(calls).to.have.length(1);
    repo.options.expirationDate = new Date("2025-02-01");
    await notifyRepositoryExpired(repo._id);
    expect(calls).to.have.length(2);
  });
  for (const scenario of ["disabled", "missing-repo", "never", "future", "missing-owner", "missing-email"]) {
    it(`skips ${scenario} without claiming delivery`, async () => {
      if (scenario === "disabled") config.RESEND_API_KEY = "";
      if (scenario === "missing-repo") repo = null;
      if (scenario === "never") repo.options.expirationMode = "never";
      if (scenario === "future") repo.options.expirationDate = new Date(Date.now() + 86400000);
      if (scenario === "missing-owner") owner = null;
      if (scenario === "missing-email") owner = {};
      await notifyRepositoryExpired("repo-object-id");
      expect(calls).to.have.length(0); expect(claims).to.have.length(0);
    });
  }
  it("does not send when the repository changed before the claim", async () => {
    stub(Repo, "updateOne", () => ({ exec: async () => ({ matchedCount: 0 }) }));
    await notifyRepositoryExpired(repo._id);
    expect(calls).to.have.length(0);
  });
  for (const failure of ["timeout", "rejection"]) it(`retains the guard on provider ${failure} without interrupting expiration`, async () => {
    let attempts = 0;
    stub(global, "fetch", async () => { attempts++; if (failure === "timeout") throw Error("timeout"); return { ok: false, status: 503 }; });
    await notifyRepositoryExpired(repo._id);
    await notifyRepositoryExpired(repo._id);
    expect(attempts).to.equal(1);
  });
});
