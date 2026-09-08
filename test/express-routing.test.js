const { expect } = require("chai");
const express = require("express");
const http = require("node:http");
require("ts-node/register/transpile-only");
const routers = require("../src/server/routes").default;
const routeUtils = require("../src/server/routes/route-utils");

function request(server, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: server.address().port, path, method,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("Express 5 route matching", function () {
  let server;
  let originals;
  before(async function () {
    originals = { getRepo: routeUtils.getRepo, getUser: routeUtils.getUser };
    routeUtils.getRepo = async (req, res) => {
      res.json({ repoId: req.params.repoId, path: req.params.path || [] });
      return null;
    };
    routeUtils.getUser = async (req) => {
      // Stop before database access, after the conference route matched.
      throw new (require("../src/core/AnonymousError").default)(
        req.params.conferenceID ? "existing_conference" : "new_conference",
        { httpStatus: 400 }
      );
    };
    const app = express();
    app.use((req, _res, next) => { req.isAuthenticated = () => true; next(); });
    app.use("/api/repo", routers.file);
    app.use("/w", routers.webview);
    app.use("/api/conferences", routers.conference);
    server = await new Promise(resolve => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
  });
  after(async function () {
    Object.assign(routeUtils, originals);
    if (server) await new Promise(resolve => server.close(resolve));
  });

  for (const path of ["README.md", "docs/nested/file.md", "docs/%E4%B8%AD%20a%3Fb.md"]) {
    it(`routes repository file ${path}`, async function () {
      const response = await request(server, `/api/repo/repo-id/file/${path}`);
      expect(response.status).to.equal(200);
      expect(JSON.parse(response.body)).to.deep.equal({
        repoId: "repo-id", path: path.split("/").map(decodeURIComponent),
      });
    });
  }
  it("does not route an empty file path", async function () {
    expect((await request(server, "/api/repo/repo-id/file/")).status).to.equal(404);
  });
  it("serves the web view root with a trailing slash", async function () {
    const response = await request(server, "/w/repo-id/");
    expect(response.status).to.equal(200);
    expect(JSON.parse(response.body)).to.deep.equal({ repoId: "repo-id", path: [] });
  });
  it("redirects the web view root without a trailing slash", async function () {
    const response = await request(server, "/w/repo-id");
    expect(response.status).to.equal(302);
    expect(response.headers.location).to.equal("/w/repo-id/");
  });
  it("routes nested web view files", async function () {
    const response = await request(server, "/w/repo-id/docs/index.html");
    expect(response.status).to.equal(200);
    expect(JSON.parse(response.body).path).to.deep.equal(["docs", "index.html"]);
  });
  for (const [path, error] of [["/", "new_conference"], ["/conference-id", "existing_conference"]]) {
    it(`routes conference POST ${path}`, async function () {
      const response = await request(server, `/api/conferences${path}`, "POST");
      expect(response.status).to.equal(400);
      expect(JSON.parse(response.body).error).to.equal(error);
    });
  }
});
