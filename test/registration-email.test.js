/* global fetch, AbortSignal, URL */
const { expect } = require("chai");
const express = require("express");
const session = require("express-session");
const passport = require("passport");
require("ts-node/register/transpile-only");
const Users = require("../src/core/model/users/users.model").default;
const credentials = require("../src/core/credentials");
const notifications = require("../src/core/owner-notifications");
const github = require("../src/core/github-app");
const { saveRegistrationEmail } = require("../src/core/registration-email");
const { verify, router } = require("../src/server/routes/connection");
const { githubAppRouter } = require("../src/server/routes/github-app");

const verified = (email, primary = true) => ({ email, primary, verified: true });

describe("registration email collection", function () {
  const restores = [];
  const stub = (object, key, value) => { const old = object[key]; restores.push(() => object[key] = old); object[key] = value; };
  let response, calls, writes, user, saved, login;
  beforeEach(() => {
    response = [verified("primary@example.com")]; calls = []; writes = []; saved = [];
    user = new Users({ username: "owner", externalIDs: { github: "10" }, emails: [] });
    stub(global, "fetch", async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => response };
    });
    stub(Users, "updateOne", async (filter, update) => { writes.push({ filter, update }); return { modifiedCount: 1 }; });
    stub(Users, "findOne", async () => user);
    stub(Users.prototype, "save", async function () { saved.push(this); return this; });
    stub(credentials, "setCredential", async () => {});
    stub(notifications, "resetOwnerAccessAlerts", async () => {});
    stub(github, "saveAppGrant", async () => {});
    stub(github, "exchangeAppToken", async () => ({ access_token: "fresh-app-token" }));
    stub(github, "githubRequest", async path => {
      expect(path).to.equal("/user"); return { id: 10, login: "owner" };
    });
    login = () => new Promise((resolve, reject) => verify({ githubOAuthContext: { expires: Date.now() + 60000 } },
      "fresh-oauth-token", "", { id: "10", username: "owner", emails: [] }, (error, identity) => error ? reject(error) : resolve(identity)));
  });
  afterEach(() => { while (restores.length) restores.pop()(); });

  it("saves the verified primary private address instead of an unverified or GitHub placeholder address", async () => {
    response = [verified("secondary@example.com", false), { email: "unverified@example.com", primary: true, verified: false },
      verified("123+owner@users.noreply.github.com"), verified(" primary@example.com "), null];
    await saveRegistrationEmail(user, "fresh-token");
    expect(user.emails.map(e => ({ email: e.email, default: e.default }))).to.deep.equal([{ email: "primary@example.com", default: true }]);
    expect(calls[0].url).to.equal("https://api.github.com/user/emails?per_page=100");
    expect(calls[0].options.headers.Authorization).to.equal("Bearer fresh-token");
    expect(calls[0].options.signal).to.be.instanceOf(AbortSignal);
    expect(writes[0].update.$set.emails).to.deep.equal([{ email: "primary@example.com", default: true }]);
  });

  it("uses a verified secondary address when the primary is a privacy placeholder", async () => {
    response = [verified("owner@users.noreply.github.com"), verified("secondary@example.com", false)];
    await saveRegistrationEmail(user, "token");
    expect(user.emails[0].email).to.equal("secondary@example.com");
  });

  for (const preference of ["stored-email", "custom-alert"]) it(`preserves ${preference} without requesting private email data`, async () => {
    if (preference === "stored-email") user.emails = [{ email: "saved@example.com", default: true }];
    else user.notificationEmail = "custom@example.com";
    await saveRegistrationEmail(user, "token");
    expect(calls).to.have.length(0); expect(writes).to.have.length(0);
  });

  it("does not overwrite a concurrent manual email save", async () => {
    stub(Users, "updateOne", async (filter) => {
      expect(filter.notificationEmail).to.equal(null);
      expect(filter.$or).to.deep.equal([{ emails: [] }, { emails: { $exists: false } }]);
      return { modifiedCount: 0 };
    });
    await saveRegistrationEmail(user, "token");
    expect(user.emails).to.have.length(0);
  });

  for (const body of [[], {}, [verified("owner@users.noreply.github.com")], [{ email: "unverified@example.com", verified: false }], [verified("bad\r\nBcc:other@example.com")]]) {
    it(`leaves the manual prompt available when no usable verified address is returned: ${JSON.stringify(body)}`, async () => {
      response = body; await saveRegistrationEmail(user, "token");
      expect(user.emails).to.have.length(0); expect(writes).to.have.length(0);
    });
  }

  for (const provider of ["OAuth", "App"]) {
    async function callback() {
      if (provider === "OAuth") return (await login()).user;
      const handler = githubAppRouter.stack.find(l => l.route?.path === "/app/callback").route.stack.at(-1).handle;
      let identity, location;
      const req = { query: { code: "code", state: "state" }, session: { githubAppFlow: { state: "state", expires: Date.now() + 60000, returnTo: "/dashboard" }, save: cb => cb() },
        isAuthenticated: () => false, login: (value, cb) => { identity = value; cb(); } };
      await handler(req, { redirect: value => { location = value; } });
      expect(location).to.equal("/dashboard"); return identity.user;
    }
    it(`saves an email during new ${provider} registration`, async () => {
      stub(Users, "findOne", async () => null);
      const identity = await callback();
      expect(saved).to.have.length(1); expect(writes).to.have.length(1);
      expect(identity.emails[0].email).to.equal("primary@example.com");
    });
    it(`fills missing email on existing ${provider} sign-in`, async () => {
      expect((await callback()).emails[0].email).to.equal("primary@example.com");
      expect(saved).to.have.length(0);
    });
    for (const failure of ["permission", "timeout", "database"]) it(`allows ${provider} sign-in when email collection fails due to ${failure}`, async () => {
      if (failure === "permission") stub(global, "fetch", async () => ({ ok: false, status: 403 }));
      if (failure === "timeout") stub(global, "fetch", async () => { throw new Error("timeout"); });
      if (failure === "database") stub(Users, "updateOne", async () => { throw new Error("database unavailable"); });
      expect((await callback()).id).to.equal(user.id);
      expect(user.emails).to.have.length(0);
    });
  }

  it("rejects an identity mismatch before requesting or saving email", async () => {
    const error = await new Promise(resolve => verify({ githubOAuthContext: { githubId: "different", expires: Date.now() + 60000 } },
      "token", "", { id: "10", username: "owner" }, resolve));
    expect(error.message).to.equal("github_identity_mismatch"); expect(calls).to.have.length(0); expect(writes).to.have.length(0);
  });
});

describe("OAuth registration permissions", function () {
  it("requests private email access on the actual GitHub authorization redirect", async () => {
    const app = express();
    app.use(session({ secret: "registration-test", saveUninitialized: false, resave: false }));
    app.use(passport.initialize()); app.use("/github", router);
    let server;
    await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/github/login`, { redirect: "manual" });
      expect(response.status).to.equal(302);
      const url = new URL(response.headers.get("location"));
      expect(url.hostname).to.equal("github.com");
      expect(url.searchParams.get("scope").split(",")).to.include.members(["repo", "user:email"]);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
});
