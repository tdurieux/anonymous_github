require("ts-node/register/transpile-only");
const { expect } = require("chai");
const express = require("express");
const http = require("http");
const { createHash } = require("crypto");
const { setTimeout: delay } = require("timers/promises");
const {
  createReviewCompletionService,
} = require("../src/server/service/review-completion-http");
const {
  ReviewConsentError,
} = require("../src/server/service/review-owner-consent");
const client = "1".repeat(32),
  intent = "2".repeat(32),
  token = "3".repeat(64);
const exchangePath = "/service/v1/completions/exchange";
const readPath = `/service/v1/intents/${intent}/receipt`;
const command = () => ({
  contract: "4open.artifacts/1",
  clientId: client,
  intentId: intent,
  code: "4".repeat(64),
  requestId: "5".repeat(32),
});
const receipt = () => ({
  contract: "4open.artifacts/1",
  clientId: client,
  intentId: intent,
  bindingId: "6".repeat(32),
  submissionRef: "7".repeat(32),
  entitlementId: "8".repeat(32),
  policy: {
    version: 1,
    access: "restricted-review",
    retainUntil: "2199-01-01T00:00:00Z",
  },
});
const config = (scopes = ["completion.exchange", "receipt.read"]) =>
  JSON.stringify({
    version: 1,
    keys: [
      {
        clientId: client,
        keyId: "current",
        tokenSHA256: createHash("sha256").update(token).digest("hex"),
        notBefore: "2026-01-01T00:00:00Z",
        notAfter: "2027-01-01T00:00:00Z",
        scopes,
      },
    ],
  });
describe("review completion service HTTP transport", function () {
  this.timeout(20000);
  let server, backend, calls, clock;
  async function start(raw = config(), beforeParser = true) {
    const app = express();
    app.set("trust proxy", "loopback");
    if (!beforeParser) app.use(express.json());
    app.use(
      createReviewCompletionService(
        raw === null ? undefined : raw,
        backend,
        () => clock,
      ),
    );
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
  }
  beforeEach(async () => {
    clock = Date.parse("2026-09-27T12:00:00Z");
    calls = [];
    backend = {
      exchange: async (id, body) => {
        calls.push({ id, body });
        return receipt();
      },
      receipt: async (id) => {
        calls.push({ id });
        return receipt();
      },
    };
  });
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      server = undefined;
    }
  });
  function request(path = exchangePath, options = {}) {
    const body =
      options.raw === undefined
        ? path === exchangePath && options.body !== false
          ? JSON.stringify(options.body || command())
          : undefined
        : options.raw;
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path,
          method: options.method || (body === undefined ? "GET" : "POST"),
          headers: {
            "X-Forwarded-Proto": "https",
            "X-4open-Artifact-Client-ID": client,
            "X-4open-Artifact-Service-Key-ID": "current",
            Authorization: "Bearer " + token,
            ...(body === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(body),
                }),
            ...options.headers,
          },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: JSON.parse(text),
            }),
          );
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
  it("requires scoped service credentials and returns the exact client receipt", async () => {
    await start();
    const result = await request();
    expect(result.status).equal(200);
    expect(result.body).deep.equal(receipt());
    expect(result.headers["cache-control"]).equal("no-store");
    expect(result.headers["referrer-policy"]).equal("no-referrer");
    expect(result.headers["set-cookie"]).equal(undefined);
    expect(result.headers["access-control-allow-origin"]).equal(undefined);
    expect((await request(readPath)).status).equal(200);
    expect(calls).length(2);
  });
  it("stays disabled without a dedicated registry", async () => {
    await start(null);
    expect((await request()).status).equal(404);
    expect(calls).length(0);
  });
  it("does not permit a read credential to exchange a completion", async () => {
    await start(config(["receipt.read"]));
    expect((await request()).status).equal(401);
    expect((await request(readPath)).status).equal(200);
    expect(calls).length(1);
  });
  it("rejects capabilities-only configuration and malformed or duplicate registry fields", () => {
    const old = JSON.parse(config());
    delete old.keys[0].scopes;
    for (const raw of [
      JSON.stringify(old),
      config().replace('"version":1', '"version":1,"version":1'),
      config().replace('"receipt.read"', '"unknown"'),
      "{",
    ])
      expect(() => createReviewCompletionService(raw, backend)).to.throw(
        "Invalid review exchange credentials",
      );
  });
  it("rejects browser context, cleartext, encodings and duplicate authentication headers", async () => {
    await start();
    for (const headers of [
      { Cookie: "session=untrusted" },
      { Origin: "https://example.test" },
      { Referer: "https://example.test" },
      { "Sec-Fetch-Site": "none" },
      { "X-Forwarded-Proto": "http" },
      { "Content-Encoding": "gzip" },
      { Authorization: ["Bearer " + token, "Bearer " + token] },
    ]) {
      const result = await request(exchangePath, { headers });
      expect(result.status).oneOf([400, 401, 403]);
      expect(result.headers.connection).equal("close");
    }
    expect(calls).length(0);
  });
  it("rejects noncanonical routes, queries, read bodies and wrong methods", async () => {
    await start();
    for (const path of [
      exchangePath + "/",
      exchangePath + "?x=1",
      readPath + "?x=1",
      "/service/v1/intents/" + intent.toUpperCase() + "F/receipt",
    ])
      expect((await request(path, { method: "POST", raw: "{}" })).status).equal(
        404,
      );
    expect(
      (await request(exchangePath, { method: "GET", body: false })).status,
    ).equal(405);
    expect(
      (await request(readPath, { method: "GET", raw: "{}" })).status,
    ).equal(400);
    expect(calls).length(0);
  });
  it("rejects duplicate decoded JSON keys, unknown fields, malformed UTF-8 and excessive bodies", async () => {
    await start();
    const valid = JSON.stringify(command());
    for (const raw of [
      valid.replace('"code":', '"code":"' + "0".repeat(64) + '","co\\u0064e":'),
      JSON.stringify({ ...command(), extra: true }),
      valid + "{}",
      "[]",
      Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]),
      " ".repeat(65537),
    ])
      expect((await request(exchangePath, { raw })).status).equal(400);
    expect(calls).length(0);
  });
  it("rejects wrong client scope and unsupported wire versions", async () => {
    await start();
    expect(
      (
        await request(exchangePath, {
          body: { ...command(), clientId: "a".repeat(32) },
        })
      ).status,
    ).equal(403);
    expect(
      (
        await request(exchangePath, {
          body: { ...command(), contract: "4open.artifacts/2" },
        })
      ).status,
    ).equal(422);
    expect(calls).length(0);
  });
  it("fails closed if mounted after a JSON parser", async () => {
    await start(config(), false);
    expect((await request()).status).equal(503);
    expect(calls).length(0);
  });
  it("rechecks credential expiry after backend work and filters invalid receipts", async () => {
    backend.exchange = async () => {
      clock = Date.parse("2027-01-01T00:00:00Z");
      return receipt();
    };
    await start();
    expect((await request()).status).equal(401);
    clock = Date.parse("2026-09-27T12:00:00Z");
    backend.exchange = async () => ({ ...receipt(), owner: "private-owner" });
    const result = await request();
    expect(result.status).equal(503);
    expect(JSON.stringify(result.body)).not.include("private-owner");
  });
  it("uses fixed errors without exposing backend details", async () => {
    await start();
    for (const [kind, status] of [
      ["invalid", 400],
      ["forbidden", 403],
      ["expired", 410],
      ["conflict", 409],
      ["unavailable", 503],
    ]) {
      backend.exchange = async () => {
        throw new ReviewConsentError(kind);
      };
      const result = await request();
      expect(result.status).equal(status);
      expect(result.body.requestId).match(/^[a-f0-9]{32}$/);
    }
    backend.exchange = async () => {
      throw new Error("secret database diagnostics");
    };
    const result = await request();
    expect(result.status).equal(503);
    expect(JSON.stringify(result.body)).not.include("diagnostics");
  });
  it("limits concurrent operations until the backend settles", async () => {
    const pending = [];
    backend.exchange = () => new Promise((resolve) => pending.push(resolve));
    await start();
    const requests = Array.from({ length: 4 }, () => request());
    for (let i = 0; i < 100 && pending.length < 4; i++) await delay(5);
    expect(pending).length(4);
    expect((await request()).status).equal(503);
    pending.forEach((resolve) => resolve(receipt()));
    expect((await Promise.all(requests)).every((r) => r.status === 200)).equal(
      true,
    );
    backend.exchange = async () => receipt();
    expect((await request()).status).equal(200);
  });
  it("limits client requests and restores capacity in the next minute", async () => {
    await start();
    for (let i = 0; i < 60; i++)
      expect((await request(readPath)).status).equal(200);
    expect((await request(readPath)).status).equal(429);
    clock += 60000;
    expect((await request(readPath)).status).equal(200);
  });
  it("closes unauthorized incomplete uploads before reading their bodies", async () => {
    await start();
    const startTime = Date.now();
    const result = await request(exchangePath, {
      raw: "{",
      headers: {
        Authorization: "Bearer " + "0".repeat(64),
        "Content-Length": "60000",
      },
    });
    expect(result.status).equal(401);
    expect(Date.now() - startTime).lessThan(2000);
    expect(calls).length(0);
  });
  it("bounds authenticated incomplete uploads without invoking the backend", async () => {
    await start();
    const result = await request(exchangePath, {
      raw: "{",
      headers: { "Content-Length": "60000" },
    });
    expect(result.status).equal(503);
    expect(calls).length(0);
  });
  it('supports overlapping rotation keys with independent validity windows', async () => {
    const settings=JSON.parse(config()), nextToken='b'.repeat(64);
    settings.keys[0].notAfter='2026-09-27T12:00:01Z';
    settings.keys.push({...settings.keys[0],keyId:'next',tokenSHA256:createHash('sha256').update(nextToken).digest('hex'),notBefore:'2026-09-27T12:00:00Z',notAfter:'2027-01-01T00:00:00Z'});
    await start(JSON.stringify(settings));
    const headers={'X-4open-Artifact-Service-Key-ID':'next',Authorization:'Bearer '+nextToken};
    expect((await request(readPath)).status).equal(200);
    expect((await request(readPath,{headers})).status).equal(200);
    clock+=1000; expect((await request(readPath)).status).equal(401);
    expect((await request(readPath,{headers})).status).equal(200);
    clock-=2000; expect((await request(readPath,{headers})).status).equal(401);
  });
  it('measures 50 authenticated receipt reads with a synthetic backend', async () => {
    await start(); const times=[]; const process=require('process');
    for(let i=0;i<50;i++) { const startTime=process.hrtime.bigint(); expect((await request(readPath)).status).equal(200); times.push(Number(process.hrtime.bigint()-startTime)/1e6); }
    times.sort((a,b)=>a-b);
    if(process.env.TEST_REVIEW_COMPLETION_HTTP_PERF) require('fs').writeFileSync(process.env.TEST_REVIEW_COMPLETION_HTTP_PERF,JSON.stringify({calls:50,workload:'loopback HTTP with trusted-proxy TLS metadata and synthetic backend, no provider or database',medianMs:times[24],p95Ms:times[47]},null,2)+'\n');
  });

});
