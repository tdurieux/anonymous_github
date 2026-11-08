require("ts-node/register/transpile-only");
const { expect } = require("chai");
const express = require("express");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createReviewConsentPage,
  isReviewConsentPagePath,
} = require("../src/server/review-consent-page");

describe("isolated review consent page", function () {
  let server, directory, manifest;
  beforeEach(async function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-page-"));
    manifest = path.join(directory, "manifest.json");
    const app = express();
    const page = createReviewConsentPage(manifest);
    app.use((req, res) =>
      isReviewConsentPagePath(req.path)
        ? page(req, res)
        : res.status(418).end(),
    );
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
  });
  afterEach(async function () {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function get(url, method = "GET") {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path: url,
          method,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode, headers: res.headers, body }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }
  it("serves only first-party assets with no inline scripts or external frames", async function () {
    const response = await get("/review-link");
    expect(response.status).equal(200);
    expect(response.headers["cache-control"]).equal("no-store");
    expect(response.headers["referrer-policy"]).equal("no-referrer");
    expect(response.headers["x-frame-options"]).equal("DENY");
    expect(response.headers["content-security-policy"])
      .include("script-src 'self'")
      .include("frame-ancestors 'none'");
    expect(response.body).include('name="review-consent-page"');
    expect(response.body).not.match(/https?:|kofi|ko-fi|<iframe|<script\s*>/i);
    expect(response.body.match(/<script /g)).length(2);
    expect(response.body)
      .include("/script/core.min.js")
      .include("/script/vendor.min.js");
  });
  it("reserves encoded, case and slash aliases and rejects query strings and writes", async function () {
    for (const url of [
      "/review-link/",
      "/REVIEW-LINK",
      "/%72eview-link",
      "/review-link?token=secret",
      "/review-link///",
    ]) {
      const response = await get(url);
      expect(response.status, url).equal(404);
      expect(response.body).not.include("<html");
      expect(response.headers["referrer-policy"]).equal("no-referrer");
    }
    expect((await get("/review-link", "POST")).status).equal(404);
    expect((await get("/review-link-other")).status).equal(418);
    expect(isReviewConsentPagePath("/%")).equal(false);
  });
  it("accepts hashed filenames but rejects manifest URL and HTML injection", async function () {
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        "core.min.js": "core.abc123.js",
        "vendor.min.js": "//evil.test/x.js",
        "all.min.css": 'x.css" onload="alert(1)',
      }),
    );
    const response = await get("/review-link");
    expect(response.body)
      .include("/script/core.abc123.js")
      .include("/script/vendor.min.js")
      .include("/css/all.min.css");
    expect(response.body).not.include("evil.test").not.include("onload");
    fs.writeFileSync(manifest, "null");
    expect((await get("/review-link")).status).equal(200);
    fs.writeFileSync(manifest, "{");
    expect((await get("/review-link")).status).equal(200);
  });
  it("serves HEAD without a body", async function () {
    const response = await get("/review-link", "HEAD");
    expect(response.status).equal(200);
    expect(response.body).equal("");
  });
  it("measures 100 isolated page responses", async function () {
    const times = [];
    const { performance } = require("perf_hooks");
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      expect((await get('/review-link')).status).equal(200);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const output = require("process").env.TEST_REVIEW_PAGE_PERF_REPORT;
    if (output) fs.writeFileSync(output, JSON.stringify({ requests: 100, workload: 'isolated HTML shell, loopback HTTP, no browser or provider', medianMs: times[49], p95Ms: times[94] }, null, 2) + '\n');
  });

});
