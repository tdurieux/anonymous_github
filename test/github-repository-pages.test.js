const { expect } = require("chai");
require("ts-node/register/transpile-only");
const db = require("../src/server/database");
const gh = require("../src/core/GitHubUtils");
const { getRepositoryFromGitHub } = require("../src/core/source/GitHubRepository");

describe("repository metadata with restricted Pages settings", function () {
  let originalOctokit;
  let originalConnected;
  beforeEach(function () {
    originalOctokit = gh.octokit;
    originalConnected = db.isConnected;
    db.isConnected = false;
  });
  afterEach(function () {
    gh.octokit = originalOctokit;
    db.isConnected = originalConnected;
  });

  function mockPages(getPages) {
    gh.octokit = () => ({ repos: {
      get: async () => ({ data: {
        id: 123, full_name: "ncusi/PatchScope", name: "PatchScope",
        owner: { login: "ncusi" }, html_url: "https://github.com/ncusi/PatchScope",
        default_branch: "main", has_pages: true, size: 42,
      } }),
      getPages,
    } });
  }
  const options = { owner: "ncusi", repo: "PatchScope", accessToken: "test", force: true };

  for (const status of [403, 404]) {
    it(`loads repository details when Pages settings return ${status}`, async function () {
      mockPages(async () => { throw Object.assign(new Error("Pages unavailable"), { status }); });
      const repo = await getRepositoryFromGitHub({ ...options });
      expect(repo.toJSON()).to.include({ fullName: "ncusi/PatchScope", defaultBranch: "main", hasPage: true });
      expect(repo.toJSON().pageSource.branch).to.equal(undefined);
      expect(repo.toJSON().pageSource.path).to.equal(undefined);
    });
  }

  it("preserves the Pages source when settings are accessible", async function () {
    const source = { branch: "main", path: "/docs" };
    mockPages(async args => {
      expect(args).to.deep.equal({ owner: "ncusi", repo: "PatchScope" });
      return { data: { source } };
    });
    const repo = await getRepositoryFromGitHub({ ...options });
    expect(repo.toJSON().pageSource.toObject()).to.deep.equal(source);
  });

  for (const status of [401, 429, 500]) {
    it(`propagates Pages failures with status ${status}`, async function () {
      const failure = Object.assign(new Error("GitHub failure"), { status });
      mockPages(async () => { throw failure; });
      let caught;
      try { await getRepositoryFromGitHub({ ...options }); } catch (error) { caught = error; }
      expect(caught).to.equal(failure);
    });
  }
});
