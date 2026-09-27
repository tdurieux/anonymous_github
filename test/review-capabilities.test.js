require("ts-node/register/transpile-only");
const { expect } = require("chai");
const { createHash } = require("crypto");
const http = require("http");
const process = require("process");
const express = require("express");
const {
  createReviewCapabilities,
} = require("../src/server/service/review-capabilities");
const client = "a".repeat(32),
  token = "b".repeat(64);
const digest = (value) =>
  createHash("sha256").update(value, "ascii").digest("hex");
const key = (overrides = {}) => ({
  clientId: client,
  keyId: "rotation-1",
  tokenSHA256: digest(token),
  notBefore: "2026-01-01T00:00:00Z",
  notAfter: "2027-01-01T00:00:00Z",
  ...overrides,
});
const config = (keys) => JSON.stringify({ version: 1, keys });
const headers = {
  "X-4open-Artifact-Client-Id": client,
  "X-4open-Artifact-Service-Key-Id": "rotation-1",
  Authorization: "Bearer " + token,
};
describe("review service capabilities", function () {
  let server, port, time, downstream;
  async function start(raw = config([key()])) {
    time = Date.parse("2026-06-01T00:00:00Z");
    downstream = 0;
    const app = express();
    app.use(
      "/service",
      createReviewCapabilities(raw, () => time),
    );
    app.use((_req, res) => {
      downstream++;
      res.setHeader("Set-Cookie", "browser=1");
      res.send("browser");
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  }
  function request(options = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/service/v1/capabilities",
          method: "GET",
          headers,
          ...options,
        },
        (res) => {
          const parts = [];
          res.on("data", (data) => parts.push(data));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text: Buffer.concat(parts).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  }
  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = undefined;
    }
  });
  it("is disabled without a registry and bypasses browser middleware", async () => {
    // Explicitly omit configuration, rather than start()'s test default.
    const app = express();
    app.use("/service", createReviewCapabilities());
    app.use((_q, r) => r.send("browser"));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    port = server.address().port;
    const result = await request();
    expect(result.status).to.equal(404);
    expect(result.headers["set-cookie"]).to.equal(undefined);
  });
  it("advertises only the supported contract, bound to the authenticated client", async () => {
    await start();
    const result = await request();
    expect(result.status).to.equal(200);
    expect(JSON.parse(result.text)).to.deep.equal({
      contract: "4open.artifacts/1",
      clientId: client,
      contracts: ["4open.artifacts/1"],
      available: [],
    });
    expect(result.headers["cache-control"]).to.equal("no-store");
    expect(result.headers["referrer-policy"]).to.equal("no-referrer");
    expect(result.headers["set-cookie"]).to.equal(undefined);
    expect(result.headers["access-control-allow-origin"]).to.equal(undefined);
    expect(downstream).to.equal(0);
  });
  it("rejects missing, wrong, duplicated and cross-client credentials without reflecting secrets", async () => {
    await start();
    for (const input of [
      {},
      { ...headers, Authorization: "Bearer " + "c".repeat(64) },
      { ...headers, "X-4open-Artifact-Client-Id": "d".repeat(32) },
      { ...headers, "X-4open-Artifact-Service-Key-Id": "unknown" },
      {
        ...headers,
        Authorization: [headers.Authorization, headers.Authorization],
      },
      { ...headers, "X-4open-Artifact-Client-Id": [client, client] },
      {
        ...headers,
        "X-4open-Artifact-Service-Key-Id": ["rotation-1", "rotation-1"],
      },
    ]) {
      const r = await request({ headers: input });
      expect(r.status).to.equal(401);
      const failure = JSON.parse(r.text);
      expect(failure.code).to.equal("unauthorized");
      expect(failure.requestId).to.match(/^[a-f0-9]{32}$/);
      expect(r.text).not.to.contain(token);
      expect(r.text).not.to.contain(client);
    }
    expect(downstream).to.equal(0);
  });
  it("has exact paths and rejects browser context, methods, queries and bodies", async () => {
    await start();
    for (const path of [
      "/service/v1/capabilities/",
      "/service/v1/capabilities?code=secret",
      "/service/v1/%63apabilities",
      "/service/v1/bindings",
      "/service/V1/capabilities",
    ])
      expect((await request({ path })).status, path).to.equal(404);
    for (const method of ["POST", "PUT", "OPTIONS", "HEAD"])
      expect((await request({ method })).status).to.equal(405);
    for (const name of [
      "Cookie",
      "Origin",
      "Referer",
      "Sec-Fetch-Site",
      "Sec-Fetch-Mode",
      "Sec-Fetch-Dest",
      "Sec-Fetch-User",
    ])
      expect(
        (await request({ headers: { ...headers, [name]: "browser" } })).status,
      ).to.equal(403);
    expect(
      (
        await request({
          headers: { ...headers, "Content-Type": "application/json" },
        })
      ).status,
    ).to.equal(400);
    expect(
      (
        await request({
          headers: { ...headers, "Content-Length": "2" },
          body: "{}",
        })
      ).status,
    ).to.equal(400);
    expect(downstream).to.equal(0);
  });
  it("supports overlapping keys with inclusive start, exclusive expiry and restart revocation", async () => {
    const other = "c".repeat(64);
    await start(
      config([key(), key({ keyId: "rotation-2", tokenSHA256: digest(other) })]),
    );
    time = Date.parse(key().notBefore) - 1;
    expect((await request()).status).to.equal(401);
    time++;
    expect((await request()).status).to.equal(200);
    expect(
      (
        await request({
          headers: {
            ...headers,
            "X-4open-Artifact-Service-Key-Id": "rotation-2",
            Authorization: "Bearer " + other,
          },
        })
      ).status,
    ).to.equal(200);
    time = Date.parse(key().notAfter);
    expect((await request()).status).to.equal(401);
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
    await start(
      config([key({ keyId: "rotation-2", tokenSHA256: digest(other) })]),
    );
    expect((await request()).status).to.equal(401);
  });
  it("limits reads per client across keys and resets without allocating anonymous counters", async () => {
    const other = "c".repeat(64);
    await start(
      config([key(), key({ keyId: "rotation-2", tokenSHA256: digest(other) })]),
    );
    const results = await Promise.all(
      Array.from({ length: 60 }, () => request()),
    );
    expect(results.every((r) => r.status === 200)).to.equal(true);
    const r = await request({
      headers: {
        ...headers,
        "X-4open-Artifact-Service-Key-Id": "rotation-2",
        Authorization: "Bearer " + other,
      },
    });
    expect(r.status).to.equal(429);
    expect(r.headers["retry-after"]).to.equal("60");
    expect(JSON.parse(r.text).retryAfterSeconds).to.equal(60);
    time += 60000;
    expect((await request()).status).to.equal(200);
  });
  it("validates bounded digest-only closed configuration without leaking it", () => {
    const bad = [
      "",
      "{",
      "x".repeat(65537),
      "null",
      "[]",
      config([]),
      JSON.stringify({ version: 2, keys: [key()] }),
      config([key({ secret: token })]),
      config([key({ tokenSHA256: token.toUpperCase() })]),
      config([key(), key()]),
      config([key(), key({ keyId: "other" })]),
      config([key({ notAfter: key().notBefore })]),
      config([key({ notBefore: "2026-02-30T00:00:00Z" })]),
      config([key({ notBefore: "2026-01-01T01:00:00+01:00" })]),
      config([key({ clientId: "../client" })]),
      config([key({ keyId: "a:b" })]),
      config(
        Array.from({ length: 17 }, (_, i) =>
          key({ keyId: "k" + i, tokenSHA256: digest(String(i)) }),
        ),
      ),
    ];
    for (const raw of bad)
      expect(() => createReviewCapabilities(raw)).to.throw(
        "Invalid REVIEW_SERVICE_KEYS configuration",
      );
  });
  if (process.env.RUN_REVIEW_SERVICE_BENCHMARK === "1")
    it("records bounded loopback read performance", async () => {
      await start();
      const samples = [];
      for (let i = 0; i < 150; i++) {
        if (i % 50 === 0) time += 60000;
        const begin = process.hrtime.bigint();
        const r = await request();
        expect(r.status).to.equal(200);
        samples.push(Number(process.hrtime.bigint() - begin) / 1e6);
      }
      samples.sort((a, b) => a - b);
      const report = {
        requests: samples.length,
        transport: "loopback HTTP, fresh connections, synthetic credentials",
        meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
        medianMs: samples[75],
        p95Ms: samples[142],
        providerCalls: false,
      };
      require("fs").writeFileSync(
        "/tmp/upstream-capabilities-perf.json",
        JSON.stringify(report, null, 2) + "\n",
      );
    });
});
