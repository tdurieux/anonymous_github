/* global fetch */
const { expect } = require("chai");
const express = require("express");
const session = require("express-session");
const { Passport } = require("passport");
require("ts-node/register/transpile-only");
const { getUser } = require("../src/server/routes/route-utils");

describe("anonymous OAuth session preservation", function () {
  let server;
  let base;

  before(async function () {
    const app = express();
    const passport = new Passport();
    app.use(session({ secret: "test-session-secret", resave: false, saveUninitialized: false }));
    app.use(passport.initialize());
    app.use(passport.session());
    app.get("/start", (req, res) => {
      req.session["oauth2:github.com"] = { state: "legacy-state" };
      req.session.githubAppFlow = { state: "app-state" };
      res.json({ id: req.sessionID });
    });
    app.get("/callback", async (req, res) => {
      const pendingLogouts = [];
      const logout = req.logout.bind(req);
      req.logout = done => {
        pendingLogouts.push(new Promise((resolve, reject) => {
          logout(error => {
            done(error);
            if (error) reject(error);
            else resolve();
          });
        }));
      };
      // Both the rate limiter and anonymous API requests check getUser.
      for (let i = 0; i < 2; i++) {
        try {
          await getUser(req);
          return res.status(500).json({ error: "anonymous-user-authenticated" });
        } catch (error) {
          if (error.message !== "not_connected") throw error;
        }
      }
      await Promise.all(pendingLogouts);
      res.json({ id: req.sessionID, legacy: req.session["oauth2:github.com"], app: req.session.githubAppFlow });
    });
    await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async function () {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  it("retains legacy and App state when checking an anonymous user", async function () {
    const start = await fetch(`${base}/start`);
    const cookie = start.headers.get("set-cookie").split(";")[0];
    const initial = await start.json();
    const callback = await fetch(`${base}/callback`, { headers: { Cookie: cookie } });
    expect(callback.status).to.equal(200);
    expect(await callback.json()).to.deep.equal({
      id: initial.id,
      legacy: { state: "legacy-state" },
      app: { state: "app-state" },
    });
  });

  it("still logs out an invalid authenticated identity", async function () {
    let loggedOut = false;
    try {
      await getUser({ user: {}, logout(done) { loggedOut = true; done(); } });
      throw new Error("Expected authentication rejection");
    } catch (error) {
      expect(error.message).to.equal("not_connected");
      expect(error.httpStatus).to.equal(401);
    }
    expect(loggedOut).to.equal(true);
  });
});
