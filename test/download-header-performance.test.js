const { expect } = require("chai");
const express = require("express");
const http = require("node:http");
const { Readable } = require("node:stream");
require("ts-node/register/transpile-only");
const utils = require("../src/server/routes/route-utils");
const AnonymizedFile = require("../src/core/AnonymizedFile").default;
const fileRouter = require("../src/server/routes/file").default;
const webRouter = require("../src/server/routes/webview").default;
const config = require("../src/config").default;

describe("download headers and website revalidation", function () {
  let server, restore, repo, transfers, blobSha;
  beforeEach(async function () {
    const originalGetRepo = utils.getRepo;
    const originals = Object.fromEntries(["originalPath", "sha", "size", "send", "getFileInfo", "anonymizedContent"].map(key => [key, AnonymizedFile.prototype[key]]));
    restore = () => { utils.getRepo = originalGetRepo; Object.assign(AnonymizedFile.prototype, originals); };
    transfers = 0; blobSha = "first";
    repo = { repoId: "fixture", options: { terms: ["author"], image: true, pdf: true, page: true, pageSource: { branch: "main", path: "/" } },
      model: { source: { commit: "commit", branch: "main" }, treeGeneration: "first" }, isReady: async () => true, countView: async () => {} };
    utils.getRepo = async () => repo;
    AnonymizedFile.prototype.originalPath = async function () { return this.anonymizedPath; };
    AnonymizedFile.prototype.sha = async () => blobSha;
    AnonymizedFile.prototype.size = async () => 10;
    AnonymizedFile.prototype.getFileInfo = async () => ({ name: "page.md", path: "", size: 10 });
    AnonymizedFile.prototype.send = async function (res) { transfers++; res.send("fixture content"); };
    AnonymizedFile.prototype.anonymizedContent = async () => { transfers++; return Readable.from(["# Anonymized page"]); };
    const app = express(); app.use("/api/repo", fileRouter); app.use("/w", webRouter);
    server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  });
  afterEach(async function () { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); restore(); });
  function fetch(path, method = "GET", headers = {}) {
    return new Promise((resolve, reject) => {
      http.request({ host: "127.0.0.1", port: server.address().port, path, method, headers }, res => {
        let body = ""; res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on("error", reject).end();
    });
  }
  it("serves file HEAD metadata without reading content", async function () {
    const response = await fetch("/api/repo/fixture/file/data.txt", "HEAD");
    expect(response.status).to.equal(200); expect(response.body).to.equal("");
    expect(response.headers["etag"]).to.match(/^"f-/); expect(response.headers["content-type"]).to.include("text/plain");
    expect(transfers).to.equal(0);
  });
  it("preserves content gates for HEAD", async function () {
    repo.options.pdf = false;
    expect((await fetch("/api/repo/fixture/file/private.pdf", "HEAD")).status).to.equal(403);
    expect(transfers).to.equal(0);
  });
  it("rejects oversized file HEAD without downloading", async function () {
    AnonymizedFile.prototype.size = async () => config.MAX_FILE_SIZE + 1;
    expect((await fetch("/api/repo/fixture/file/huge.txt", "HEAD")).status).to.equal(413); expect(transfers).to.equal(0);
  });
  it("accepts weak and multiple validators without transferring file content", async function () {
    const first = await fetch("/api/repo/fixture/file/data.txt", "HEAD");
    const response = await fetch("/api/repo/fixture/file/data.txt", "GET", { "If-None-Match": `"unrelated", W/${first.headers.etag}` });
    expect(response.status).to.equal(304); expect(transfers).to.equal(0);
  });
  it("revalidates a Markdown website before fetching or rendering it again", async function () {
    const first = await fetch("/w/fixture/page.md");
    expect(first.status).to.equal(200); expect(first.body).to.include("Anonymized page"); expect(transfers).to.equal(1);
    const second = await fetch("/w/fixture/page.md", "GET", { "If-None-Match": `W/${first.headers.etag}` });
    expect(second.status).to.equal(304); expect(second.body).to.equal(""); expect(transfers).to.equal(1);
    expect(second.headers["content-security-policy"]).to.include("sandbox");
  });
  it("serves website HEAD without reading or rendering Markdown", async function () {
    const response = await fetch("/w/fixture/page.md", "HEAD");
    expect(response.status).to.equal(200); expect(response.headers["content-type"]).to.include("text/html"); expect(transfers).to.equal(0);
  });
  it("serves TypeScript website HEAD with the same text MIME policy as GET", async function () {
    const response = await fetch("/w/fixture/code.ts", "HEAD");
    expect(response.status).to.equal(200); expect(response.headers["content-type"]).to.include("text/plain"); expect(transfers).to.equal(0);
  });
  for (const change of ["terms", "commit", "tree", "cache", "blob", "source name"]) {
    it(`invalidates the website validator when ${change} changes`, async function () {
      const first = await fetch("/w/fixture/page.md");
      if (change === "terms") repo.options.terms = ["new author"];
      if (change === "commit") repo.model.source.commit = "new commit";
      if (change === "tree") repo.model.treeGeneration = "new tree";
      if (change === "cache") repo.model.contentCacheRevision = "new cache";
      if (change === "blob") blobSha = "new blob";
      if (change === "source name") repo.model.source.repositoryName = "new/source";
      const second = await fetch("/w/fixture/page.md", "GET", { "If-None-Match": first.headers.etag });
      expect(second.status).to.equal(200); expect(second.headers.etag).not.to.equal(first.headers.etag); expect(transfers).to.equal(2);
    });
  }
  it("checks website permissions before honoring an old validator", async function () {
    const first = await fetch("/w/fixture/page.md"); repo.options.page = false;
    expect((await fetch("/w/fixture/page.md", "GET", { "If-None-Match": first.headers.etag })).status).to.equal(400);
    expect(transfers).to.equal(1);
  });
});
