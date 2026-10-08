/* global fetch */
const { expect } = require("chai");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
require("ts-node/register/transpile-only");
const { requestRateLimitKey } = require("../src/server/rate-limit-key");

describe("rate limiter client addresses", function () {
  const key = (ip, headers = {}, remoteAddress = "127.0.0.1") =>
    requestRateLimitKey({ ip, headers, socket: { remoteAddress } });

  it("normalizes IPv4 ports and mapped IPv6 without truncating native IPv6", function () {
    expect(key("192.0.2.1:1234")).to.equal("192.0.2.1");
    expect(key("::ffff:192.0.2.1")).to.equal("192.0.2.1");
    expect(key("2001:db8:abcd:1200::1234")).to.equal("2001:db8:abcd:1200::/56");
    expect(key("2001:db8:abcd:1300::1234")).not.to.equal(key("2001:db8:abcd:1200::1234"));
  });

  it("accepts the visitor header only for a Cloudflare edge address", function () {
    expect(key("192.0.2.1", { "cf-connecting-ip": "198.51.100.1" })).to.equal("192.0.2.1");
    expect(key("104.16.0.1", { "cf-connecting-ip": " 198.51.100.1 " })).to.equal("198.51.100.1");
    expect(key("104.16.0.1", { "cf-connecting-ip": " " })).to.equal("104.16.0.1");
    expect(key(undefined, {}, "::ffff:192.0.2.1")).to.equal("192.0.2.1");
  });

  it("shares limits across IPv6 addresses within a subnet and ignores forged Cloudflare headers", async function () {
    const app = express();
    app.set("trust proxy", "loopback");
    app.use(rateLimit({ windowMs: 60000, limit: 1, keyGenerator: requestRateLimitKey }));
    app.get("/", (_req, res) => res.send("ok"));
    let server;
    await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
    const request = (ip, visitor) => fetch(`http://127.0.0.1:${server.address().port}/`, {
      headers: { "x-forwarded-for": ip, "cf-connecting-ip": visitor },
    });
    try {
      expect((await request("2001:db8:abcd:1200::1", "198.51.100.1")).status).to.equal(200);
      expect((await request("2001:db8:abcd:12ff::2", "198.51.100.2")).status).to.equal(429);
      expect((await request("2001:db8:abcd:1300::1", "198.51.100.1")).status).to.equal(200);
      expect((await request("192.0.2.1", "198.51.100.1")).status).to.equal(200);
      expect((await request("::ffff:192.0.2.1", "198.51.100.2")).status).to.equal(429);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
});
