/* global fetch */
const { expect } = require("chai");
const express = require("express");
const session = require("express-session");
const { createClient } = require("redis");
const { RedisStore: SessionStore } = require("connect-redis");
const { RedisStore: RateLimitStore } = require("rate-limit-redis");
const { rateLimit } = require("express-rate-limit");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const port = Number(process.env.PERFORMANCE_REDIS_PORT);

(port ? describe : describe.skip)("upgraded Redis stores and session cleanup", function () {
  this.timeout(15000);
  let redis, server, base;
  const prefix = `dependency-test:${process.pid}:`;
  before(async function () {
    redis = createClient({ socket: { host: "127.0.0.1", port, reconnectStrategy: false } });
    redis.on("error", () => {});
    await redis.connect();
    const app = express();
    app.use(session({ secret: "dependency-test", resave: false, saveUninitialized: false,
      store: new SessionStore({ client: redis, prefix: `${prefix}session:` }) }));
    app.get("/session", (req, res) => {
      req.session.visits = (req.session.visits || 0) + 1;
      res.json({ visits: req.session.visits });
    });
    const limiter = () => rateLimit({ windowMs: 60000, limit: 1, keyGenerator: () => "client",
      store: new RateLimitStore({ prefix: `${prefix}limit:`, sendCommand: (...args) => redis.sendCommand(args) }) });
    app.get("/first", limiter(), (_req, res) => res.send("ok"));
    app.get("/second", limiter(), (_req, res) => res.send("ok"));
    await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async function () {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    if (redis?.isOpen) {
      for await (const keys of redis.scanIterator({ MATCH: `${prefix}*` })) {
        if (keys.length) await redis.del(keys);
      }
      await redis.del([`anoGH_session:${prefix}legacy`, `anoGH_session:${prefix}current`]);
      await redis.close();
    }
  });

  it("persists sessions across HTTP requests", async function () {
    const first = await fetch(`${base}/session`);
    expect(await first.json()).to.deep.equal({ visits: 1 });
    const cookie = first.headers.get("set-cookie").split(";")[0];
    const second = await fetch(`${base}/session`, { headers: { Cookie: cookie } });
    expect(await second.json()).to.deep.equal({ visits: 2 });
  });

  it("shares a request quota between separate Redis store instances", async function () {
    expect((await fetch(`${base}/first`)).status).to.equal(200);
    expect((await fetch(`${base}/second`)).status).to.equal(429);
  });

  it("scans session batches, preserves current sessions and applies legacy cleanup", async function () {
    const legacy = `anoGH_session:${prefix}legacy`, current = `anoGH_session:${prefix}current`;
    await redis.set(legacy, JSON.stringify({ passport: { user: { id: "legacy" } } }));
    await redis.set(current, JSON.stringify({ passport: { user: "current" } }));
    const run = async args => {
      const result = await promisify(execFile)(process.execPath,
        ["-r", "ts-node/register", "src/scripts/purge-legacy-sessions.ts", ...args], {
          cwd: path.resolve(__dirname, ".."), timeout: 10000,
          env: { ...process.env, NODE_ENV: "test", REDIS_HOSTNAME: "127.0.0.1", REDIS_PORT: String(port) },
        });
      return JSON.parse(result.stdout.trim().split("\n").at(-1));
    };
    expect(await run([])).to.deep.equal({ found: 1, removed: 0 });
    expect(await redis.exists(legacy)).to.equal(1);
    expect(await run(["--apply"])).to.deep.equal({ found: 1, removed: 1 });
    expect(await redis.exists(legacy)).to.equal(0);
    expect(await redis.get(current)).to.equal(JSON.stringify({ passport: { user: "current" } }));
  });
});
