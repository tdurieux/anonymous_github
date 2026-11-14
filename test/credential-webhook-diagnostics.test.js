const { expect } = require("chai");
const { createHmac } = require("crypto");
require("ts-node/register/transpile-only");
const { handleError } = require("../src/server/routes/route-utils");
const { getAllRepositories } = require("../src/server/routes/user");
const { githubAppWebhook } = require("../src/server/routes/github-app");
const config = require("../src/config").default;
const Installation = require("../src/core/model/github-installation").default;
const AnonymousError = require("../src/core/AnonymousError").default;

function response() {
  return { headersSent: false, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }, getHeader() { return "request-id"; } };
}

describe("credential and webhook failure diagnostics", () => {
  const restores = [];
  function stub(object, key, value) { const original = object[key]; object[key] = value; restores.push(() => { object[key] = original; }); }
  afterEach(() => restores.splice(0).reverse().forEach(restore => restore()));
  it("logs generic upstream 401 as warning while retaining server errors", () => {
    const warnings = [], errors = [];
    stub(console, "warn", (...args) => warnings.push(args));
    stub(console, "error", (...args) => errors.push(args));
    handleError(Object.assign(new Error("denied"), { status: 401 }), response());
    handleError(Object.assign(new Error("failed"), { response: { statusCode: 503 } }), response());
    expect(warnings).to.have.length(1); expect(errors).to.have.length(1);
    expect(errors.flat().join(" ")).to.include('"httpStatus":503');
  });
  it("logs got HTTP401 as warning with its actual status", () => {
    const warnings = []; stub(console, "warn", (...args) => warnings.push(args));
    const failure = Object.assign(new Error("Unauthorized"), { response: { statusCode: 401 } });
    Object.setPrototypeOf(failure, require("got").HTTPError.prototype);
    const res = response(); handleError(failure, res);
    expect(warnings).to.have.length(1); expect(res.code).to.equal(401);
  });
  for (const status of [401, 403, 429, 503]) it(`normalizes only confirmed discovery 401 (${status})`, async () => {
    const failure = Object.assign(new Error("private provider details"), { status });
    let received;
    try { await getAllRepositories({ getGitHubRepositories: async () => { throw failure; } }, true); }
    catch (error) { received = error; }
    if (status === 401) {
      expect(received).to.be.instanceOf(AnonymousError);
      expect(received.message).to.equal("token_expired"); expect(received.httpStatus).to.equal(401);
    } else expect(received).to.equal(failure);
  });
  it("preserves App-specific reconnect errors", async () => {
    const failure = new AnonymousError("github_app_reconnect_required", { httpStatus: 401 });
    try { await getAllRepositories({ getGitHubRepositories: async () => { throw failure; } }, true); throw Error("expected denial"); }
    catch (error) { expect(error).to.equal(failure); }
  });
  it("logs signed webhook persistence failures without secrets and still returns 503", async () => {
    stub(config, "GITHUB_APP_ENABLED", true); stub(config, "GITHUB_APP_ID", "123");
    stub(config, "GITHUB_APP_WEBHOOK_SECRET", "test-secret");
    const messages = []; stub(console, "error", (...args) => messages.push(args));
    stub(Installation, "updateOne", async () => { throw new Error("secret-token https://private/?token=secret"); });
    const body = Buffer.from(JSON.stringify({ action: "added", installation: { id: 4, app_id: 123 }, private: "private-body" }));
    const req = { body, headers: { "x-github-event": "installation_repositories", "x-github-delivery": "abcd-1234",
      "x-hub-signature-256": "sha256=" + createHmac("sha256", "test-secret").update(body).digest("hex") } };
    const handler = githubAppWebhook.stack.find(layer => layer.route).route.stack.at(-1).handle;
    const res = response(); await handler(req, res);
    expect(res.code).to.equal(503); expect(res.body.error).to.equal("webhook_processing_failed");
    const text = JSON.stringify(messages);
    expect(text).to.include("persist_installation_block").and.include("abcd-1234");
    expect(text).not.to.include("secret-token"); expect(text).not.to.include("private-body"); expect(text).not.to.include("https://");
    expect(text).not.to.include(req.headers["x-hub-signature-256"]);
  });
});
