const { expect } = require("chai");
const express = require("express");
const http = require("node:http");
require("ts-node/register/transpile-only");
const utils = require("../src/server/routes/route-utils");
const admin = require("../src/server/routes/admin").default;

describe("performance report access", function () {
  let server, original;
  before(async function () {
    original = utils.getUser;
    utils.getUser = async req => ({ isAdmin: req.get("x-fixture-user") === "admin", model: { id: "fixture" } });
    const app = express();
    app.use((req, _res, next) => { req.isAuthenticated = () => !!req.get("x-fixture-user"); next(); });
    app.use("/api/admin", admin);
    server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  });
  after(async function () { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); utils.getUser = original; });
  async function request(user) {
    return new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: server.address().port, path: "/api/admin/performance", headers: user ? { "x-fixture-user": user } : {} }, res => {
        let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
      }).on("error", reject);
    });
  }
  it("rejects anonymous requests", async function () { expect((await request()).status).to.equal(401); });
  it("rejects non-admin users", async function () { expect((await request("regular")).status).to.equal(401); });
  it("allows admins and disables HTTP caching", async function () {
    const result = await request("admin"); expect(result.status).to.equal(200);
    expect(JSON.parse(result.body).available).to.equal(false); expect(result.headers["cache-control"]).to.equal("no-store");
  });
});
