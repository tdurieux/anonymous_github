const { expect } = require("chai");
const express = require("express");
const http = require("http");
const { Readable } = require("stream");
const { URL } = require("url");
const got = require("got");
require("ts-node/register/transpile-only");
const AnonymizedFile = require("../src/core/AnonymizedFile").default;
const GitHubStream = require("../src/core/source/GitHubStream").default;
const utils = require("../src/server/routes/route-utils");
const router = require("../src/server/routes/file").default;

async function collect(input) { const chunks = []; for await (const chunk of input) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString(); }
async function listen(app) { return new Promise(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); }); }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

describe("folder file endpoint disclosure", function () {
  this.timeout(10000);
  const restores = [];
  function stub(object, key, value) { const old = object[key]; object[key] = value; restores.push(() => { object[key] = old; }); }
  afterEach(() => restores.splice(0).reverse().forEach(restore => restore()));

  for (const size of [undefined, null]) {
    it(`rejects folder metadata with size ${size} before any cached or upstream content`, async () => {
      const f = new AnonymizedFile({ repository: { options: { terms: [] }, model: { source: { type: "GitHubStream" } } }, anonymizedPath: "strategy1/.idea" });
      f._file = { name: ".idea", path: "strategy1", sha: "tree-sha", size };
      for (const call of [() => f.content(), () => f.anonymizedContent(), () => f.send({})]) {
        const error = await call().catch(error => error);
        expect(error.message).to.equal("folder_not_supported"); expect(error.httpStatus).to.equal(404);
      }
    });
  }
  it("keeps zero-byte files and repository HTML downloadable", async () => {
    for (const [name, size] of [["empty.txt", 0], ["index.html", 123]]) {
      const f = new AnonymizedFile({ repository: { options: { terms: [] }, model: { source: { type: "GitHubStream" } } }, anonymizedPath: name });
      f._file = { name, path: "", size, sha: "blob-sha" };
      await f.assertContentFile();
    }
  });
  it("rejects GET, HEAD and conditional folder requests without trailing slash", async () => {
    stub(utils, "getRepo", async () => ({ options: { terms: [] }, isReady: async () => true }));
    stub(AnonymizedFile.prototype, "getFileInfo", async () => ({ name: ".idea", path: "strategy1", sha: "tree-sha" }));
    stub(AnonymizedFile.prototype, "send", async () => { throw Error("must not serve cached content"); });
    const app = express(); app.use("/api/repo", router); const server = await listen(app);
    try {
      for (const method of ["GET", "HEAD"]) {
        const response = await got(`http://127.0.0.1:${server.address().port}/api/repo/test/file/strategy1/.idea`, { method, headers: { "if-none-match": "*" }, throwHttpErrors: false });
        expect(response.statusCode).to.equal(404);
        if (method === "GET") expect(JSON.parse(response.body).error).to.equal("folder_not_supported");
      }
    } finally { await close(server); }
  });
  it("blocks a real HTTP redirect to a GitHub tree page before fetching its HTML", async () => {
    const warnings = [];
    stub(console, "warn", (...args) => warnings.push(args.join(" ")));
    const server = await listen(http.createServer((_req, res) => { res.writeHead(302, { location: "https://github.com/example/private-repo/tree/main/folder?token=secret-query" }); res.end(); }));
    const original = got.stream;
    stub(got, "stream", (_url, options) => original(`http://127.0.0.1:${server.address().port}/raw`, options));
    const source = new GitHubStream({ repoId: "test", organization: "example", repoName: "repo", commit: "main", getToken: () => "" });
    try {
      const error = await collect(await source.downloadWithFallback("", "tree-sha", "folder")).catch(error => error);
      expect(error.message).to.equal("upstream_error");
      expect(warnings.join(" ")).to.include("github.com").and.include("host");
      expect(warnings.join(" ")).not.to.include("private-repo");
      expect(warnings.join(" ")).not.to.include("secret-query");
    } finally { await close(server); }
  });
  it("rejects a successful web-page response before emitting any bytes", async () => {
    const server = await listen(http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>owner metadata</html>"); }));
    const original = got.stream;
    stub(got, "stream", (_url, options) => original(`http://127.0.0.1:${server.address().port}/raw`, options));
    const source = new GitHubStream({ repoId: "test", organization: "example", repoName: "repo", commit: "main", getToken: () => "" });
    let bytes = 0;
    try {
      const stream = await source.downloadWithFallback("", "tree-sha", "folder");
      stream.on("data", chunk => { bytes += chunk.length; });
      const error = await collect(stream).catch(error => error);
      expect(error.message).to.equal("upstream_error"); expect(bytes).to.equal(0);
    } finally { await close(server); }
  });
  it("allows raw/LFS redirects and legitimate HTML file bodies", async () => {
    stub(got, "stream", (_url, options) => {
      for (const host of ["raw.githubusercontent.com", "media.githubusercontent.com"]) {
        options.hooks.beforeRedirect[0]({ url: new URL(`https://${host}/owner/repo/main/index.html`) });
      }
      return Readable.from(["<html>repository file</html>"]);
    });
    const source = new GitHubStream({ repoId: "test", organization: "example", repoName: "repo", commit: "main", getToken: () => "" });
    expect(await collect(await source.downloadWithFallback("", "blob-sha", "index.html"))).to.equal("<html>repository file</html>");
  });
});
