const { expect } = require("chai");
require("ts-node/register/transpile-only");
const GitHubUtils = require("../src/core/GitHubUtils");
const { sourceFileList, SOURCE_FILE_LIST_LIMIT } = require("../src/core/source-file-list");

describe("sourceFileList (#941)", function () {
  const original = GitHubUtils.octokit;
  let response;
  let request;
  beforeEach(() => {
    GitHubUtils.octokit = () => ({
      repos: { getCommit: async ({ ref }) => ({ data: { sha: ref.padEnd(40, "0") } }) },
      git: { getTree: async (params) => {
        request = params;
        if (response instanceof Error) throw response;
        return { data: response };
      } },
    });
  });
  afterEach(() => { GitHubUtils.octokit = original; });

  const opt = { owner: "o", repo: "r", commit: "a".repeat(40), accessToken: "t" };

  it("lists text files of the commit, sorted, without folders, submodules or binaries", async function () {
    response = { truncated: false, tree: [
      { type: "tree", path: "paper" },
      { type: "blob", path: "paper/refs.bib" },
      { type: "blob", path: "README.md" },
      { type: "blob", path: "fig.png" },
      { type: "blob", path: ".gitmodules" },
      { type: "commit", path: "vendor/lib" },
    ] };
    expect(await sourceFileList(opt)).to.deep.equal({ files: ["README.md", "paper/refs.bib"], truncated: false });
    expect(request).to.include({ owner: "o", repo: "r", tree_sha: "a".repeat(40), recursive: "true" });
  });

  it("resolves an abbreviated commit hash before reading the tree", async function () {
    response = { truncated: false, tree: [] };
    await sourceFileList({ ...opt, commit: "abc123" });
    expect(request.tree_sha).to.equal("abc123".padEnd(40, "0"));
  });

  it("reports GitHub truncation and caps the list", async function () {
    response = { truncated: true, tree: [{ type: "blob", path: "a.txt" }] };
    expect((await sourceFileList(opt)).truncated).to.equal(true);
    response = { truncated: false, tree: Array.from({ length: SOURCE_FILE_LIST_LIMIT + 1 }, (_, i) => ({ type: "blob", path: `f${i}.txt` })) };
    const capped = await sourceFileList(opt);
    expect(capped.files).to.have.length(SOURCE_FILE_LIST_LIMIT);
    expect(capped.truncated).to.equal(true);
  });

  it("maps a missing repository or commit to repo_not_found", async function () {
    response = Object.assign(new Error("Not Found"), { status: 404 });
    try { await sourceFileList(opt); expect.fail("should throw"); }
    catch (error) { expect(error.message).to.equal("repo_not_found"); }
  });
});
