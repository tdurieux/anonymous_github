/* global fetch */
const { expect } = require("chai");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout, clearTimeout } = require("node:timers");

describe("development proxy", function () {
  this.timeout(15000);
  let upstream, child, base, target;
  before(async function () {
    upstream = http.createServer((req, res) => {
      if (req.url === "/api/headers") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ origin: req.headers.origin, referer: req.headers.referer }));
      }
      res.setHeader("set-cookie", "test=value; Domain=localhost; Secure; SameSite=None; Path=/");
      if (req.url === "/api/redirect") {
        res.writeHead(302, { location: `${target}/api/next` });
        return res.end();
      }
      res.setHeader("content-type", "text/html");
      res.end(`<a href="${target}/api/next">next</a>`);
    });
    await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
    target = `http://127.0.0.1:${upstream.address().port}`;
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["scripts/dev-proxy.js"], {
      cwd: path.resolve(__dirname, ".."), env: { ...process.env, UPSTREAM: target, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      let output = "", errors = "";
      const timer = setTimeout(() => reject(new Error("Development proxy startup timed out")), 10000);
      child.stderr.on("data", chunk => { errors += chunk; });
      child.stdout.on("data", chunk => {
        output += chunk;
        if (output.includes("dev-proxy")) { clearTimeout(timer); resolve(); }
      });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Proxy exited with ${code}: ${errors}`)); });
    });
  });
  after(async function () {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    if (upstream) {
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
    }
  });

  it("forwards the request hooks to the upstream", async function () {
    const response = await fetch(`${base}/api/headers`);
    expect(response.status).to.equal(200);
    expect(await response.json()).to.deep.equal({ origin: target, referer: `${target}/api/headers` });
  });

  it("rewrites HTML, cookies and redirects for localhost", async function () {
    const response = await fetch(`${base}/api/html`);
    expect(await response.text()).to.equal('<a href="/api/next">next</a>');
    const cookie = response.headers.get("set-cookie");
    expect(cookie).to.include("SameSite=Lax");
    expect(cookie).not.to.match(/Secure|Domain=/i);
    const redirect = await fetch(`${base}/api/redirect`, { redirect: "manual" });
    expect(redirect.status).to.equal(302);
    expect(redirect.headers.get("location")).to.equal("/api/next");
  });

  it("serves the local UI with resolved asset names", async function () {
    const response = await fetch(base);
    expect(response.status).to.equal(200);
    const body = await response.text();
    expect(body).to.include('id="app"');
    expect(body).not.to.include("__CORE_JS__");
    expect(body).not.to.include("__VENDOR_JS__");
  });
});
