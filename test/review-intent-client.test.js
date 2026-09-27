const { expect } = require("chai");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const process = require("process");
const { fork, execFileSync } = require("child_process");
const {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
} = require("timers");
const clientId = "a".repeat(32),
  intentId = "c".repeat(32);
const at = (offset) =>
  new Date(Math.floor((Date.now() + offset) / 1000) * 1000)
    .toISOString()
    .replace(".000Z", "Z");
const input = () => ({
  contract: "4open.artifacts/1",
  clientId,
  intentId,
  token: "d".repeat(64),
  requestId: "e".repeat(32),
});
const intent = () => ({
  contract: "4open.artifacts/1",
  clientId,
  intentId,
  submissionRef: "f".repeat(32),
  callbackId: "1".repeat(32),
  entitlementId: "2".repeat(32),
  expiresAt: at(120000),
  policy: {
    version: 1,
    access: "restricted-review",
    retainUntil: at(86400000),
  },
});

describe("review intent HTTPS client", function () {
  this.timeout(20000);
  let server,
    child,
    folder,
    origin,
    handler,
    calls,
    serial = 0;
  const pending = new Map();
  const config = () => ({
    origin,
    clientId,
    keyId: "rotation-1",
    token: "b".repeat(64),
    notBefore: at(-60000),
    notAfter: at(3600000),
  });
  function call(options = {}) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("child test timed out"));
      }, 18000);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child.send({ id, config: config(), input: input(), ...options });
    });
  }
  before(async function () {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "review-intent-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
        "-keyout",
        path.join(folder, "key"),
        "-out",
        path.join(folder, "cert"),
      ],
      { stdio: "ignore" },
    );
    server = https.createServer(
      {
        key: fs.readFileSync(path.join(folder, "key")),
        cert: fs.readFileSync(path.join(folder, "cert")),
      },
      (req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          calls.push({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          });
          handler(req, res);
        });
      },
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = "https://127.0.0.1:" + server.address().port;
    child = fork(path.join(__dirname, "fixtures/review-intent-client.js"), {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(folder, "cert") },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.on("message", (message) => {
      const done = pending.get(message.id);
      pending.delete(message.id);
      if (done) done(message);
    });
  });
  after(async function () {
    child?.kill();
    server?.closeAllConnections();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (folder) fs.rmSync(folder, { recursive: true, force: true });
  });
  beforeEach(() => {
    calls = [];
    handler = (_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(intent()));
    };
  });
  it("uses authenticated TLS, the saved policy, and the caller's retry ID", async () => {
    const result = await call({ mode: "mutate" });
    expect(result.result.policy.access).to.equal("restricted-review");
    expect(result.frozen).to.equal(true);
    expect(result.serialized).to.equal("{}");
    expect(calls).to.have.length(1);
    expect(calls[0].body).to.deep.equal(input());
    expect(calls[0].method).to.equal("POST");
    expect(calls[0].url).to.equal("/service/v1/artifact-intents/consume");
    expect(calls[0].headers.authorization).to.equal("Bearer " + "b".repeat(64));
    expect(calls[0].headers["x-4open-artifact-client-id"]).to.equal(clientId);
    expect(calls[0].headers["x-4open-artifact-service-key-id"]).to.equal(
      "rotation-1",
    );
    for (const key of ["cookie", "origin", "referer"])
      expect(calls[0].headers[key]).to.equal(undefined);
    await call();
    expect(calls[1].body.requestId).to.equal(calls[0].body.requestId);
  });
  it("rejects invalid config and caller data before making a request", async () => {
    for (const patch of [
      { origin: origin + "/" },
      { origin: "http://127.0.0.1" },
      { origin: origin + "/path" },
      { token: "bad" },
      { notAfter: at(-1000) },
      { notBefore: at(30000) },
      { clientId: "bad" },
      { extra: "ignored?" },
    ])
      expect((await call({ config: { ...config(), ...patch } })).kind).to.equal(
        "invalid",
      );
    for (const patch of [
      { clientId: "0".repeat(32) },
      { token: "bad" },
      { requestId: "bad" },
      { policy: {} },
      { contract: "other" },
    ])
      expect((await call({ input: { ...input(), ...patch } })).kind).to.equal(
        "invalid",
      );
    expect((await call({ mode: "preabort" })).kind).to.equal("unavailable");
    expect(calls).to.have.length(0);
  });
  it("classifies failures without following redirects, retrying, or exposing response bodies", async () => {
    for (const [status, kind] of [
      [301, "protocol"],
      [400, "rejected"],
      [401, "rejected"],
      [403, "rejected"],
      [404, "not-found"],
      [409, "conflict"],
      [410, "expired"],
      [422, "rejected"],
      [429, "unavailable"],
      [503, "unavailable"],
    ]) {
      handler = (_req, res) => {
        res.writeHead(status, {
          Location: origin + "/leak",
          "Content-Length": "10000000",
        });
        res.write("private response and token");
      };
      const result = await call();
      expect(result.kind).to.equal(kind);
      expect(result.message).to.equal("Review intent consumption " + kind);
    }
    expect(calls).to.have.length(10);
  });
  it("rejects mismatched identity, policy, expiry, unknown fields and malformed JSON", async () => {
    const good = intent();
    const values = [
      { ...good, clientId: "0".repeat(32) },
      { ...good, intentId: "0".repeat(32) },
      { ...good, callbackId: "bad" },
      { ...good, entitlementId: "bad" },
      { ...good, expiresAt: at(-1000) },
      { ...good, expiresAt: at(700000) },
      { ...good, policy: { ...good.policy, access: "public" } },
      { ...good, policy: { ...good.policy, version: 1.5 } },
      { ...good, policy: { ...good.policy, retainUntil: at(-1000) } },
      { ...good, owner: "browser" },
    ];
    const raw = [
      ...values.map((v) => JSON.stringify(v)),
      "null",
      "[]",
      "{",
      JSON.stringify(good).replace(
        '"clientId":',
        '"clientId":"' + clientId + '","cl\\u0069entId":',
      ),
      JSON.stringify(good).replace('"version":1', '"version":2,"version":1'),
      Buffer.from([0xff]),
      " ".repeat(65537),
    ];
    for (const body of raw) {
      handler = (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(body);
      };
      expect((await call()).kind).to.equal("protocol");
    }
  });
  it("rejects cookies, encoding, ambiguous content types and oversized declared bodies", async () => {
    for (const headers of [
      { "Set-Cookie": "identity=secret" },
      { "Content-Encoding": "gzip" },
      { "Content-Type": "text/html" },
      { "Content-Type": ["application/json", "application/json"] },
      { "Content-Length": "65537" },
    ]) {
      handler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json", ...headers });
        res.write(JSON.stringify(intent()));
      };
      expect((await call()).kind).to.equal("protocol");
    }
  });
  it("bounds concurrent attempts and releases capacity after completion", async () => {
    handler = (_req, res) =>
      setTimeout(() => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(intent()));
      }, 150);
    const result = await call({ mode: "parallel" });
    expect(result.results).to.deep.equal(["ok", "ok", "ok", "ok", "busy"]);
    expect(result.followup.intentId).to.equal(intentId);
    expect(calls).to.have.length(5);
  });
  it("cancels an unfinished response without retrying", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{");
    };
    expect((await call({ mode: "abort" })).kind).to.equal("unavailable");
    expect(calls).to.have.length(1);
  });
  it("times out an inactive response within its request deadline", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{");
    };
    const start = Date.now();
    expect((await call()).kind).to.equal("unavailable");
    expect(Date.now() - start).to.be.within(4500, 12000);
    expect(calls).to.have.length(1);
  });
  it("rejects an untrusted TLS certificate before sending credentials", async () => {
    const env = {
      ...process.env,
      NODE_EXTRA_CA_CERTS: "",
      NODE_TLS_REJECT_UNAUTHORIZED: "1",
    };
    delete env.NODE_OPTIONS;
    const untrusted = fork(
      path.join(__dirname, "fixtures/review-intent-client.js"),
      { env, stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    try {
      const response = new Promise((resolve) =>
        untrusted.once("message", resolve),
      );
      untrusted.send({ id: 1, config: config(), input: input() });
      expect((await response).kind).to.equal("unavailable");
      expect(calls).to.have.length(0);
    } finally {
      untrusted.kill();
    }
  });
  it("rejects a response received after the credential expires", async () => {
    handler = (_req, res) =>
      setTimeout(() => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(intent()));
      }, 2100);
    expect(
      (await call({ config: { ...config(), notAfter: at(2000) } })).kind,
    ).to.equal("unavailable");
    expect(calls).to.have.length(1);
  });
  it("enforces the total deadline even while the peer streams data", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write(" ");
      const timer = setInterval(() => res.write(" "), 200);
      res.once("close", () => clearInterval(timer));
    };
    const start = Date.now();
    expect((await call()).kind).to.equal("unavailable");
    expect(Date.now() - start).to.be.within(9500, 15000);
    expect(calls).to.have.length(1);
  });
  it("measures repeated fresh TLS connections when explicitly requested", async function () {
    if (!process.env.TEST_REVIEW_INTENT_PERF) this.skip();
    const times = [];
    for (let n = 0; n < 100; n++) {
      const result = await call();
      expect(result.result.intentId).to.equal(intentId);
      times.push(result.elapsedMs);
    }
    times.sort((a, b) => a - b);
    const receipt = {
      calls: calls.length,
      transport: "fresh loopback HTTPS connections",
      synthetic: true,
      meanMs: times.reduce((a, b) => a + b, 0) / times.length,
      medianMs: times[50],
      p95Ms: times[94],
    };
    expect(calls).to.have.length(100);
    if (process.env.TEST_REVIEW_INTENT_PERF_REPORT)
      fs.writeFileSync(
        process.env.TEST_REVIEW_INTENT_PERF_REPORT,
        JSON.stringify(receipt, null, 2) + "\n",
      );
  });
});
