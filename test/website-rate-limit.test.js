/* global fetch */
const { expect } = require("chai");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
require("ts-node/register/transpile-only");
const config = require("../src/config").default;
const { createWebsiteRateLimiter } = require("../src/server/website-rate-limit");
const { requestRateLimitKey } = require("../src/server/rate-limit-key");

describe("website request budget", function () {
  it("isolates page bursts from the API and keeps a shared website cap across repositories", async () => {
    const previous = config.WEBSITE_RATE_LIMIT;
    config.WEBSITE_RATE_LIMIT = 3;
    const app = express();
    app.set("trust proxy", "loopback");
    app.use("/api", rateLimit({ windowMs: 60000, limit: 1, keyGenerator: requestRateLimitKey }), (_req, res) => res.send("api"));
    app.use("/w", createWebsiteRateLimiter(), (_req, res) => res.send("asset"));
    let server;
    await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
    const get = (path, ip = "192.0.2.1", forged = "198.51.100.1") => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      headers: { "x-forwarded-for": ip, "cf-connecting-ip": forged },
    });
    try {
      for (const path of ["/w/one/index.html", "/w/one/image.webp", "/w/two/style.css"]) expect((await get(path)).status).to.equal(200);
      const blocked = await get("/w/three/app.js", "192.0.2.1", "198.51.100.2");
      expect(blocked.status).to.equal(429);
      expect(Number(blocked.headers.get("retry-after"))).to.be.greaterThan(0);
      expect((await blocked.json()).error).to.equal("rate_limited");
      expect((await get("/api/options")).status).to.equal(200);
      expect((await get("/api/options")).status).to.equal(429);
      expect((await get("/w/one/image.webp", "192.0.2.2")).status).to.equal(200);
      // Exhausting this visitor's API allowance does not consume website hits.
      expect((await get("/api/options", "192.0.2.3")).status).to.equal(200);
      expect((await get("/api/options", "192.0.2.3")).status).to.equal(429);
      expect((await get("/w/one/image.webp", "192.0.2.3")).status).to.equal(200);
    } finally {
      config.WEBSITE_RATE_LIMIT = previous;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  it("refuses disabled or invalid website limits", () => {
    const previous = config.WEBSITE_RATE_LIMIT;
    try {
      for (const value of [0, -1, 1.5, NaN]) {
        config.WEBSITE_RATE_LIMIT = value;
        expect(() => createWebsiteRateLimiter()).to.throw("positive integer");
      }
    } finally { config.WEBSITE_RATE_LIMIT = previous; }
  });
});
