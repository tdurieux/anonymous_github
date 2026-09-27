require("ts-node/register/transpile-only");
const { expect } = require("chai");
const express = require("express");
const session = require("express-session");
const http = require("http");
const { randomBytes } = require("crypto");
const {
  createReviewConsentRouter,
} = require("../src/server/service/review-consent-http");
const origin = "https://anonymous.example.test";
const owner = "a".repeat(24);
const intent = {
  contract: "4open.artifacts/1",
  clientId: "1".repeat(32),
  intentId: "2".repeat(32),
  token: "3".repeat(64),
  requestId: "4".repeat(32),
};
const previewInput = () => ({ repositoryId: "synthetic-repository", intent });
const confirmInput = () => ({
  ticket: "synthetic-signed-ticket",
  requestId: "5".repeat(32),
  acceptAccess: true,
  acceptRetention: true,
});
const policy = {
  version: 1,
  access: "restricted-review",
  retainUntil: "2099-01-01T00:00:00Z",
};

describe("review consent browser HTTP transport", function () {
  this.timeout(20000);
  let server, store, cookie, sid, csrf, backend, calls;
  function request(path, options = {}) {
    const body =
      options.raw === undefined
        ? options.body === undefined
          ? undefined
          : JSON.stringify(options.body)
        : options.raw;
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path,
          method: options.method || (body === undefined ? "GET" : "POST"),
          headers: {
            "X-Forwarded-Proto": "https",
            ...(cookie ? { Cookie: cookie } : {}),
            ...(body === undefined
              ? {}
              : {
                  Origin: origin,
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(body),
                  "X-Review-CSRF": csrf || "",
                }),
            ...options.headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: raw ? JSON.parse(raw) : null,
            });
          });
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
  beforeEach(async () => {
    cookie = "";
    sid = "";
    csrf = "";
    calls = [];
    store = new session.MemoryStore();
    backend = {
      preview: async (actor, repository, input) => {
        calls.push({ actor, repository, input });
        return {
          ticket: "synthetic-signed-ticket",
          repositoryName: repository,
          policy,
          expiresAt: "2098-01-01T00:00:00Z",
        };
      },
      confirm: async (actor, ticket, input) => {
        calls.push({ actor, ticket, input });
        return {
          clientId: intent.clientId,
          intentId: intent.intentId,
          accountId: actor.accountId,
          repositoryId: "b".repeat(24),
          role: "owner",
          requestId: input.requestId,
          policy,
          confirmedAt: "2026-01-01T00:00:00Z",
        };
      },
    };
    const app = express();
    // Model a TLS-terminating trusted loopback proxy, never trust arbitrary peers.
    app.set("trust proxy", "loopback");
    app.use(
      session({
        secret: "synthetic-local-session-secret",
        resave: false,
        saveUninitialized: false,
        store,
      }),
    );
    // Test-only login stands in for Passport's existing authenticated session.
    app.get("/test-login", (req, res) => {
      req.session.passport = { user: owner };
      req.session.save((error) =>
        error ? res.sendStatus(500) : res.json({ sid: req.sessionID }),
      );
    });
    app.use((req, _res, next) => {
      const id = req.session.passport?.user;
      if (id) req.user = { user: { _id: id } };
      req.isAuthenticated = () => !!id;
      next();
    });
    app.use(
      "/api/review-consent",
      createReviewConsentRouter(origin, backend, randomBytes(32)),
    );
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const login = await request("/test-login");
    cookie = login.headers["set-cookie"][0].split(";")[0];
    sid = login.body.sid;
    const issued = await request("/api/review-consent/csrf");
    expect(issued.status).to.equal(200);
    csrf = issued.body.csrf;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.clear();
  });
  it("binds CSRF to the current Passport session and omits owner identifiers from confirmation responses", async () => {
    const preview = await request("/api/review-consent/preview", {
      body: previewInput(),
    });
    expect(preview.status).to.equal(200);
    expect(calls[0].actor).to.deep.equal({ accountId: owner, sessionId: sid });
    expect(calls[0].input).to.deep.equal(intent);
    expect(preview.headers["cache-control"]).to.equal("no-store");
    expect(preview.headers["referrer-policy"]).to.equal("no-referrer");
    expect(preview.headers["access-control-allow-origin"]).to.equal(undefined);
    const result = await request("/api/review-consent/confirm", {
      body: confirmInput(),
    });
    expect(result.status).to.equal(200);
    expect(result.body).to.deep.equal({
      requestId: "5".repeat(32),
      policy,
      confirmedAt: "2026-01-01T00:00:00Z",
    });
    expect(JSON.stringify(result.body)).not.to.include(owner);
  });
  it("rejects insecure, cross-origin, bearer and missing-CSRF requests before backend work", async () => {
    for (const headers of [
      { "X-Forwarded-Proto": "http" },
      { Origin: "https://attacker.example" },
      { Origin: "null" },
      { Authorization: "Bearer synthetic" },
      { "X-Review-CSRF": "0".repeat(64) },
      { "X-Review-CSRF": "" },
      { "Sec-Fetch-Site": "same-site" },
      { "Content-Encoding": "gzip" },
    ])
      expect(
        (
          await request("/api/review-consent/preview", {
            body: previewInput(),
            headers,
          })
        ).status,
      ).to.equal(403);
    expect(
      (
        await request("/api/review-consent/preview", {
          body: previewInput(),
          headers: { Cookie: "" },
        })
      ).status,
    ).to.equal(401);
    expect(calls).to.have.length(0);
  });
  it("accepts only bounded JSON with the exact operation fields and explicit acceptance", async () => {
    for (const input of [
      { ...previewInput(), accountId: owner },
      { ...previewInput(), policy },
      { ...previewInput(), repositoryId: "../other" },
      { ...previewInput(), intent: { ...intent, requestId: "bad" } },
    ])
      expect(
        (await request("/api/review-consent/preview", { body: input })).status,
      ).to.equal(422);
    for (const input of [
      { ...confirmInput(), acceptAccess: false },
      { ...confirmInput(), acceptRetention: "true" },
      { ...confirmInput(), policy },
    ])
      expect(
        (await request("/api/review-consent/confirm", { body: input })).status,
      ).to.equal(422);
    expect(
      (await request("/api/review-consent/preview", { raw: "{" })).status,
    ).to.equal(400);
    expect(
      (await request("/api/review-consent/preview", { raw: " ".repeat(13000) }))
        .status,
    ).to.equal(413);
    expect(
      (
        await request("/api/review-consent/preview", {
          body: previewInput(),
          headers: { "Content-Type": "text/plain" },
        })
      ).status,
    ).to.equal(415);
    for (const path of ["/csrf?x=1", "/csrf/", "/CSRF", "/%63srf", "/other"])
      expect((await request("/api/review-consent" + path)).status).to.equal(
        404,
      );
    expect((await request("/api/review-consent/preview")).status).to.equal(405);
    expect(
      (await request("/api/review-consent/csrf", { method: "GET", body: {} }))
        .status,
    ).to.equal(400);
    expect(calls).to.have.length(0);
  });
  it("rejects a token copied from another session of the same account", async () => {
    const old = csrf;
    cookie = "";
    const login = await request("/test-login");
    cookie = login.headers["set-cookie"][0].split(";")[0];
    expect(
      (
        await request("/api/review-consent/preview", {
          body: previewInput(),
          headers: { "X-Review-CSRF": old },
        })
      ).status,
    ).to.equal(403);
    expect(calls).to.have.length(0);
  });
  it("reloads session authority before returning a pending policy preview", async () => {
    let arrived, release;
    const ready = new Promise((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    backend.preview = async () => {
      arrived();
      await gate;
      return {
        ticket: "private-policy-preview",
        policy,
        repositoryName: "synthetic-repository",
        expiresAt: "2098-01-01T00:00:00Z",
      };
    };
    const pending = request("/api/review-consent/preview", {
      body: previewInput(),
    });
    await ready;
    await new Promise((resolve) => store.destroy(sid, resolve));
    release();
    const result = await pending;
    expect(result.status).to.equal(401);
    expect(JSON.stringify(result.body)).not.to.include(
      "private-policy-preview",
    );
  });
  it("never rewrites or resurrects a session when a CSRF read races with logout", async () => {
    const original = store.get.bind(store);
    let reads = 0,
      arrived,
      release;
    const ready = new Promise((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    store.get = (id, callback) =>
      original(id, (error, value) => {
        if (++reads === 3) {
          arrived();
          gate.then(() => callback(error, value));
        } else callback(error, value);
      });
    let writes = 0;
    const set = store.set.bind(store);
    store.set = (...args) => {
      writes++;
      return set(...args);
    };
    const pending = request("/api/review-consent/csrf");
    await ready;
    await new Promise((resolve) => store.destroy(sid, resolve));
    release();
    await pending;
    expect(writes).to.equal(0);
    expect(
      await new Promise((resolve) =>
        original(sid, (_error, value) => resolve(value)),
      ),
    ).to.equal(undefined);
    expect(
      (await request("/api/review-consent/preview", { body: previewInput() }))
        .status,
    ).to.equal(401);
    expect(calls).to.have.length(0);
  });
  it("returns fixed failure codes without exposing provider or database messages", async () => {
    for (const [kind, status] of [
      ["forbidden", 403],
      ["conflict", 409],
      ["expired", 410],
      ["invalid", 422],
      ["unavailable", 503],
      [undefined, 503],
    ]) {
      backend.preview = async () => {
        const error = new Error("private credential and database details");
        error.kind = kind;
        throw error;
      };
      const result = await request("/api/review-consent/preview", {
        body: previewInput(),
      });
      expect(result.status).to.equal(status);
      expect(JSON.stringify(result.body)).not.to.include("private");
    }
  });
  it("bounds authenticated request rates without accepting a different client identity", async () => {
    for (let n = 0; n < 59; n++)
      expect((await request("/api/review-consent/csrf")).status).to.equal(200);
    const response = await request("/api/review-consent/csrf");
    expect(response.status).to.equal(429);
    expect(response.headers["retry-after"]).to.equal("60");
    expect(calls).to.have.length(0);
  });
  it("closes an unauthorized incomplete upload without waiting for its declared body", async () => {
    const started = Date.now();
    let pending;
    try {
      const result = await new Promise((resolve, reject) => {
        pending = http.request(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path: "/api/review-consent/preview",
            method: "POST",
            headers: {
              "X-Forwarded-Proto": "https",
              Origin: origin,
              "Content-Type": "application/json",
              "Content-Length": 10000000,
            },
          },
          (response) => {
            response.resume();
            response.on("end", () =>
              resolve({
                status: response.statusCode,
                connection: response.headers.connection,
              }),
            );
          },
        );
        pending.on("error", reject);
        pending.write("{");
      });
      expect(result).to.deep.equal({ status: 401, connection: "close" });
      expect(Date.now() - started).to.be.lessThan(2000);
      expect(calls).to.have.length(0);
    } finally {
      pending?.destroy();
    }
  });
  it("cancels a pending preview when its browser connection closes", async () => {
    let entered, aborted;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const cancelled = new Promise((resolve) => {
      aborted = resolve;
    });
    backend.preview = async (_actor, _repo, _input, signal) => {
      entered();
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      aborted();
      throw new Error("private pending request cancelled");
    };
    const body = JSON.stringify(previewInput());
    const pending = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      path: "/api/review-consent/preview",
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-Forwarded-Proto": "https",
        Origin: origin,
        "Content-Type": "application/json",
        "X-Review-CSRF": csrf,
        "Content-Length": Buffer.byteLength(body),
      },
    });
    pending.on("error", () => undefined);
    pending.end(body);
    await ready;
    pending.destroy();
    await cancelled;
  });
  it("expires an authenticated incomplete upload at the total request deadline", async () => {
    const started = Date.now();
    let pending;
    try {
      const status = await new Promise((resolve) => {
        pending = http.request(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path: "/api/review-consent/preview",
            method: "POST",
            headers: {
              Cookie: cookie,
              "X-Forwarded-Proto": "https",
              Origin: origin,
              "Content-Type": "application/json",
              "Content-Length": 1000,
              "X-Review-CSRF": csrf,
            },
          },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          },
        );
        pending.on("error", () => resolve("closed"));
        pending.write("{");
      });
      expect([408, "closed"]).to.include(status);
      expect(Date.now() - started).to.be.within(14000, 19000);
      expect(calls).to.have.length(0);
    } finally {
      pending?.destroy();
    }
  });
  it("measures authenticated HTTP preview overhead when explicitly requested", async function () {
    const process = require("process");
    if (!process.env.TEST_REVIEW_CONSENT_HTTP_PERF) this.skip();
    const times = [];
    for (let n = 0; n < 50; n++) {
      const start = process.hrtime.bigint();
      expect(
        (await request("/api/review-consent/preview", { body: previewInput() }))
          .status,
      ).to.equal(200);
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    times.sort((a, b) => a - b);
    expect(calls).to.have.length(50);
    require("fs").writeFileSync(
      process.env.TEST_REVIEW_CONSENT_HTTP_PERF,
      JSON.stringify(
        {
          calls: times.length,
          transport: "loopback HTTP with synthetic trusted-proxy TLS metadata",
          sessionStore: "in-memory test store",
          backend: "synthetic response, no MongoDB or provider timing",
          meanMs: times.reduce((a, b) => a + b, 0) / times.length,
          medianMs: times[25],
          p95Ms: times[47],
        },
        null,
        2,
      ) + "\n",
    );
  });
});
