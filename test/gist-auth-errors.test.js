const { expect } = require("chai");
require("ts-node/register/transpile-only");
const github = require("../src/core/GitHubUtils");
const Gist = require("../src/core/Gist").default;
const Model = require("../src/core/model/anonymizedGists/anonymizedGists.model").default;
const { handleError } = require("../src/server/routes/route-utils");

describe("gist authentication errors", function () {
  let original, gist, client;
  beforeEach(function () {
    original = github.octokit;
    gist = new Gist(new Model({ source: { gistId: "example" }, gist: { files: [{ filename: "saved.txt", content: "saved" }] } }));
    gist.getToken = async () => "rejected-token";
    client = { rest: { gists: { get: async () => ({ data: { files: {} } }) } }, paginate: async () => [], request: async () => ({ data: "raw" }) };
    github.octokit = token => { expect(token).to.equal("rejected-token"); return client; };
  });
  afterEach(function () { github.octokit = original; });
  for (const operation of ["metadata", "comments", "raw file"]) {
    it("requests OAuth reconnection when GitHub rejects " + operation, async function () {
      const failure = Object.assign(new Error("Bad credentials"), { status: 401 });
      const reject = async () => { throw failure; };
      if (operation === "metadata") client.rest.gists.get = reject;
      if (operation === "comments") client.paginate = reject;
      if (operation === "raw file") {
        client.rest.gists.get = async () => ({ data: { files: { file: { filename: "large.txt", truncated: true, raw_url: "https://gist.githubusercontent.com/example/raw" } } } });
        client.request = reject;
      }
      let error;
      try { await gist.download(); } catch (caught) { error = caught; }
      expect(error?.message).to.equal("github_oauth_required");
      expect(error.cause).to.equal(failure);
      let status, body;
      handleError(error, { headersSent: false, status: value => { status = value; return { json: value => { body = value; } }; } });
      expect(status).to.equal(403);
      expect(body).to.deep.equal({ error: "github_oauth_required" });
      expect(gist.model.gist.files[0].content).to.equal("saved");
    });
  }
  for (const status of [403, 404, 429, 500]) {
    it("preserves non-authentication GitHub errors: " + status, async function () {
      const failure = Object.assign(new Error("Other GitHub failure"), { status });
      client.rest.gists.get = async () => { throw failure; };
      let error;
      try { await gist.download(); } catch (caught) { error = caught; }
      expect(error).to.equal(failure);
    });
  }
  it("still downloads a gist when the credential is accepted", async function () {
    await gist.download();
    expect(gist.model.gist.files).to.have.length(0);
  });
});
