const { expect } = require("chai");
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

// Exercise the production static middleware without starting databases/workers.
function staticApp() {
  const app = express();
  const source = fs.readFileSync(path.join(__dirname, "../src/server/index.ts"), "utf8");
  const start = source.indexOf("  app.use(\n    express.static");
  const end = source.indexOf("\n\n  app", start);
  new Function("app", "express", "join", ts.transpileModule(source.slice(start, end), {}).outputText)(app, express, (...parts) => path.join(__dirname, "..", ...parts));
  return app;
}
module.exports = { staticApp };

if (typeof describe === "function") describe("sandboxed Markdown font requests", function () {
  let server;
  before(async function () { server = await new Promise(resolve => { const listener = staticApp().listen(0, "127.0.0.1", () => resolve(listener)); }); });
  after(async function () { if (server) await new Promise(resolve => server.close(resolve)); });
  it("allows anonymous opaque-origin font requests", async function () {
    const response = await globalThis.fetch(`http://127.0.0.1:${server.address().port}/css/fonts/KaTeX_Main-Regular.woff2`, { headers: { Origin: "null" } });
    expect(response.status).to.equal(200);
    expect(response.headers.get("access-control-allow-origin")).to.equal("*");
    expect(response.headers.get("access-control-allow-credentials")).to.equal(null);
    await response.arrayBuffer();
  });
  it("does not enable CORS for unrelated assets", async function () {
    const response = await globalThis.fetch(`http://127.0.0.1:${server.address().port}/script/markdown.min.js`, { headers: { Origin: "null" } });
    expect(response.status).to.equal(200);
    expect(response.headers.get("access-control-allow-origin")).to.equal(null);
    await response.arrayBuffer();
  });
});
