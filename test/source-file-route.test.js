const { expect } = require("chai");
require("ts-node/register/transpile-only");
const utils = require("../src/server/routes/route-utils");
const app = require("../src/core/github-app");
const tokens = require("../src/core/GitHubUtils");
const db = require("../src/server/database");
const router = require("../src/server/routes/repository-private").default;

const handler = (path) => router.stack.find(layer =>
  layer.route?.path === path && layer.route.methods.get).route.stack[0].handle;

// GET /api/repo/:owner/:repo/file: one file of a source commit for the
// anonymize preview, with the same access checks as /tree.
describe("GET /api/repo/:owner/:repo/file (anonymize preview)", () => {
  const restores = [];
  function stub(object, key, value) {
    const original = object[key]; restores.push(() => { object[key] = original; }); object[key] = value;
  }
  let user, selections, contentRequests, content;
  beforeEach(() => {
    user = { id: "owner-id", model: { id: "owner-id" } };
    selections = []; contentRequests = [];
    content = { type: "file", size: 11, encoding: "base64", content: Buffer.from("Jane Smith\n").toString("base64") };
    stub(utils, "getUser", async () => user);
    stub(utils, "handleError", error => { throw error; });
    stub(app, "selectRepositoryAccess", async (owner, name, kind) => {
      selections.push([owner, name, kind]);
      return { token: "selected-token" };
    });
    stub(tokens, "octokit", token => ({ repos: { getContent: async params => {
      contentRequests.push({ token, ...params });
      if (content instanceof Error) throw content;
      return { data: content };
    } } }));
  });
  afterEach(() => { while (restores.length) restores.pop()(); });

  function response() {
    const res = { headers: {}, body: undefined, type: undefined };
    res.set = (key, value) => { res.headers[key] = value; return res; };
    res.type = value => { res.type = value; return res; };
    res.send = value => { res.body = value; return res; };
    res.json = value => { res.body = value; return res; };
    return res;
  }
  const request = query => ({ params: { owner: "owner", repo: "repo" }, query: { commit: "abc1234", path: "src/a.py", connection: "github-app", ...query } });
  async function failure(query, message) {
    let error;
    try { await handler("/:owner/:repo/file")(request(query), response()); } catch (caught) { error = caught; }
    expect(error?.message).to.equal(message);
    return error;
  }

  it("returns the raw text, uncached, with the source's access", async () => {
    const res = response();
    await handler("/:owner/:repo/file")(request(), res);
    expect(res.body).to.equal("Jane Smith\n");
    expect(res.type).to.equal("text/plain; charset=utf-8");
    expect(res.headers["Cache-Control"]).to.equal("private, no-store");
    expect(selections).to.deep.equal([["owner-id", "owner/repo", "github-app"]]);
    expect(contentRequests[0]).to.include({ token: "selected-token", owner: "owner", repo: "repo", path: "src/a.py", ref: "abc1234" });
  });

  it("reports binary files as JSON instead of sending them", async () => {
    content = { type: "file", size: 5000, encoding: "base64", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]).toString("base64") };
    const res = response();
    await handler("/:owner/:repo/file")(request({ path: "fig/plot.png" }), res);
    expect(res.body).to.deep.equal({ binary: true, size: 5000 });
  });

  it("caps the size with file_too_big (413)", async () => {
    content = { type: "file", size: 2 * 1024 * 1024, encoding: "none", content: "" };
    const error = await failure({}, "file_too_big");
    expect(error.httpStatus).to.equal(413);
  });

  it("validates the commit and the path before any GitHub call", async () => {
    await failure({ commit: "main" }, "invalid_commit_format");
    await failure({ commit: undefined }, "invalid_commit_format");
    for (const path of ["../x", "a/../../etc/passwd", "/abs", "a//b", "a\\b", undefined, ["a", "b"]]) {
      await failure({ path }, "invalid_path");
    }
    expect(selections).to.have.length(0);
    expect(contentRequests).to.have.length(0);
  });

  it("checks the saved repository's owner and source like /tree", async () => {
    const repository = { owner: { id: "someone-else" }, model: { source: { repositoryName: "owner/repo" }, coauthors: [] } };
    stub(db, "getRepository", async () => repository);
    stub(utils, "isOwnerCoauthorOrAdmin", (resource, who) => {
      if (resource.owner.id !== who.id) throw Object.assign(new Error("not_authorized"), { httpStatus: 403 });
    });
    await failure({ anonymizedRepoId: "saved" }, "not_authorized");
    repository.owner.id = "owner-id";
    repository.model.source.repositoryName = "other/repo";
    await failure({ anonymizedRepoId: "saved" }, "repo_not_found");
    repository.model.source.repositoryName = "Owner/Repo";
    stub(tokens, "getToken", async () => "saved-token");
    const res = response();
    await handler("/:owner/:repo/file")(request({ anonymizedRepoId: "saved" }), res);
    expect(res.body).to.equal("Jane Smith\n");
    expect(contentRequests.at(-1).token).to.equal("saved-token");
  });

  it("maps a missing file to file_not_found", async () => {
    content = Object.assign(new Error("Not Found"), { status: 404 });
    const error = await failure({}, "file_not_found");
    expect(error.httpStatus).to.equal(404);
  });
});
