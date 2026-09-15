const { expect } = require("chai");
const express = require("express");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

function request(server, url) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path: url }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on("error", reject);
  });
}

describe("hashed asset route", function () {
  let directory;
  let server;

  before(async function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "hashed-assets-"));
    for (const [name, content] of Object.entries({
      "public/script/core.min.js": "window.core = true;",
      "public/script/plain.js": "window.plain = true;",
      "public/css/all.min.css": "body { color: red; }",
      "private.json": "private fixture outside public",
      "public-other/private.json": "private fixture in sibling directory",
    })) {
      const target = path.join(directory, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }

    // Execute the production route without starting its databases and workers.
    const source = fs.readFileSync(path.join(__dirname, "../src/server/index.ts"), "utf8");
    const start = source.indexOf("  // Hashed assets");
    const end = source.indexOf("\n  app.use(", start);
    expect(start).to.be.greaterThan(-1);
    expect(end).to.be.greaterThan(start);
    const app = express();
    const context = {
      app,
      join: path.join,
      sep: path.sep,
      resolve: (...parts) => path.resolve(directory, ...parts),
      existsSync: file => fs.existsSync(path.resolve(directory, file)),
    };
    new Function(...Object.keys(context), ts.transpileModule(source.slice(start, end), {}).outputText)(...Object.values(context));
    app.use(express.static(path.join(directory, "public"), { index: false }));
    app.use((_req, res) => res.status(404).end());
    server = await new Promise(resolve => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
  });

  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  for (const [url, content] of [
    ["/script/core.aaaaaaaaaa.min.js", "window.core = true;"],
    ["/script/plain.aaaaaaaaaa.js", "window.plain = true;"],
    ["/css/all.aaaaaaaaaa.min.css", "body { color: red; }"],
  ]) {
    it(`serves ${url} with immutable caching`, async function () {
      const response = await request(server, url);
      expect(response.status).to.equal(200);
      expect(response.body).to.equal(content);
      expect(response.headers["cache-control"]).to.equal("public, max-age=31536000, immutable");
    });
  }

  for (const dir of ["script", "css"]) {
    for (const base of [
      "../../private",
      "..%2f..%2fprivate",
      "%2e%2e%2f%2e%2e%2fprivate",
      "..%2F..%2Fprivate",
      "..%5c..%5cprivate",
      "../../public-other/private",
    ]) {
      it(`rejects traversal through /${dir}/${base}`, async function () {
        const response = await request(server, `/${dir}/${base}.aaaaaaaaaa.json`);
        expect(response.status).to.equal(404);
        expect(response.body).not.to.include("private fixture");
        expect(response.headers["cache-control"]).to.equal(undefined);
      });
    }
  }

  it("falls through for a missing hashed asset", async function () {
    expect((await request(server, "/script/missing.aaaaaaaaaa.js")).status).to.equal(404);
  });

  it("still serves unhashed static assets", async function () {
    const response = await request(server, "/script/plain.js");
    expect(response.status).to.equal(200);
    expect(response.body).to.equal("window.plain = true;");
  });
});
