/* global fetch */
const { expect } = require("chai");
const express = require("express");
const { Passport } = require("passport");
const { createClient } = require("redis");
require("ts-node/register/transpile-only");
const { initSession } = require("../src/server/routes/connection");
const port = Number(process.env.PERFORMANCE_REDIS_PORT);
const lifetime = 30 * 24 * 60 * 60;

(port ? describe : describe.skip)("persistent login sessions", function () {
  this.timeout(10000);
  let client, server, base;
  const keys = new Set();
  async function start() {
    client = createClient({ socket: { host: "127.0.0.1", port, reconnectStrategy: false } });
    const app = express();
    app.set("trust proxy", "loopback");
    app.use(initSession(client));
    const passport = new Passport();
    passport.serializeUser((user, done) => done(null, user.id));
    passport.deserializeUser((id, done) => done(null, { id }));
    app.use(passport.initialize());
    app.use(passport.session());
    app.use((req, res, next) => { keys.add(`anoGH_session:${req.sessionID}`); next(); });
    app.get("/login", (req, res, next) => req.login({ id: "test-owner" }, error => {
      if (error) return next(error);
      keys.add(`anoGH_session:${req.sessionID}`);
      res.json({ id: req.sessionID });
    }));
    app.get("/me", (req, res) => res.status(req.user ? 200 : 401).json({ id: req.sessionID, user: req.user }));
    app.get("/logout", (req, res, next) => req.logout(error => error ? next(error) : res.sendStatus(204)));
    await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await client.close();
  }
  before(start);
  after(async () => {
    for (const key of keys) await client.del(key);
    await stop();
  });
  const https = { "X-Forwarded-Proto": "https" };

  it("does not create cookies for anonymous page requests", async () => {
    const response = await fetch(`${base}/me`, { headers: https });
    expect(response.status).to.equal(401);
    expect(response.headers.get("set-cookie")).to.equal(null);
  });

  it("persists a secure cookie and Redis session across a new app instance", async () => {
    const response = await fetch(`${base}/login`, { headers: https });
    const header = response.headers.get("set-cookie");
    expect(header).to.include("HttpOnly").and.include("Secure").and.include("SameSite=Lax");
    const expires = new Date(/Expires=([^;]+)/.exec(header)[1]).getTime();
    expect(expires - Date.now()).to.be.within((lifetime - 5) * 1000, lifetime * 1000);
    const { id } = await response.json();
    expect(await client.ttl(`anoGH_session:${id}`)).to.be.within(lifetime - 5, lifetime);
    // A browser can retain an expiring cookie across restarts. Replay it to a
    // fresh middleware/Redis connection, without the original process state.
    const cookie = header.split(";")[0];
    await stop();
    await start();
    const restored = await fetch(`${base}/me`, { headers: { ...https, Cookie: cookie } });
    expect(restored.status).to.equal(200);
    expect((await restored.json()).user.id).to.equal("test-owner");
    expect(restored.headers.get("set-cookie")).to.include("Expires=");
    await client.expire(`anoGH_session:${id}`, 60);
    const renewed = await fetch(`${base}/me`, { headers: { ...https, Cookie: cookie } });
    expect(renewed.status).to.equal(200);
    expect(await client.ttl(`anoGH_session:${id}`)).to.be.within(lifetime - 5, lifetime);
    expect((await fetch(`${base}/logout`, { headers: { ...https, Cookie: cookie } })).status).to.equal(204);
    expect(await client.exists(`anoGH_session:${id}`)).to.equal(0);
    expect((await fetch(`${base}/me`, { headers: { ...https, Cookie: cookie } })).status).to.equal(401);
  });

  it("supports local HTTP development without a Secure cookie", async () => {
    const response = await fetch(`${base}/login`);
    const cookie = response.headers.get("set-cookie");
    expect(cookie).to.include("Expires=").and.include("HttpOnly").and.include("SameSite=Lax");
    expect(cookie).not.to.include("Secure");
  });
});
