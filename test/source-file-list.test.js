const { expect } = require("chai");
require("ts-node/register/transpile-only");
const GitHubUtils = require("../src/core/GitHubUtils");
const { sourceFileList, sourceFileContent, isSafeSourcePath, SOURCE_FILE_LIST_LIMIT, SOURCE_FILE_PREVIEW_LIMIT } = require("../src/core/source-file-list");

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

  it("lists text files of the commit, sorted, with binaries apart and without folders or submodules", async function () {
    response = { truncated: false, tree: [
      { type: "tree", path: "paper" },
      { type: "blob", path: "paper/refs.bib" },
      { type: "blob", path: "README.md" },
      { type: "blob", path: "fig.png" },
      { type: "blob", path: ".gitmodules" },
      { type: "commit", path: "vendor/lib" },
    ] };
    expect(await sourceFileList(opt)).to.deep.equal({ files: ["README.md", "paper/refs.bib"], binaryFiles: ["fig.png"], truncated: false });
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

describe("sourceFileContent (anonymize preview)", function () {
  const original = GitHubUtils.octokit;
  let response;
  let request;
  beforeEach(() => {
    request = null;
    GitHubUtils.octokit = () => ({
      repos: { getContent: async (params) => {
        request = params;
        if (response instanceof Error) throw response;
        return { data: response };
      } },
    });
  });
  afterEach(() => { GitHubUtils.octokit = original; });

  const opt = { owner: "o", repo: "r", commit: "abc123", path: "src/main.py", accessToken: "t" };
  const file = (text, extra = {}) => ({ type: "file", size: Buffer.byteLength(text), encoding: "base64", content: Buffer.from(text).toString("base64"), ...extra });

  it("returns the text of a file at the commit", async function () {
    response = file("print('Jane Smith')\n");
    expect(await sourceFileContent(opt)).to.deep.equal({ binary: false, content: "print('Jane Smith')\n", size: 20 });
    expect(request).to.include({ owner: "o", repo: "r", path: "src/main.py", ref: "abc123" });
  });

  it("reports binary files instead of returning them", async function () {
    response = file("\u0089PNG", { size: 2048 });
    expect(await sourceFileContent({ ...opt, path: "fig/plot.png" })).to.deep.equal({ binary: true, size: 2048 });
    response = file("\u0000\u0001\u0002\u0000binary", { size: 9 });
    expect((await sourceFileContent({ ...opt, path: "model.weights" })).binary).to.equal(true);
  });

  it("refuses files over the preview limit", async function () {
    response = { type: "file", size: SOURCE_FILE_PREVIEW_LIMIT + 1, encoding: "none", content: "" };
    try { await sourceFileContent(opt); expect.fail("should throw"); }
    catch (error) { expect(error.message).to.equal("file_too_big"); expect(error.httpStatus).to.equal(413); }
  });

  it("maps folders, submodules and missing files to file_not_found", async function () {
    for (const value of [[{ type: "file", path: "a" }], { type: "submodule" }, Object.assign(new Error("Not Found"), { status: 404 })]) {
      response = value;
      try { await sourceFileContent(opt); expect.fail("should throw"); }
      catch (error) { expect(error.message).to.equal("file_not_found"); expect(error.httpStatus).to.equal(404); }
    }
  });

  it("rejects path traversal before calling GitHub", async function () {
    for (const path of ["../secret", "a/../../b", "/etc/passwd", "a//b", "a/./b", "a\\b", "dir/", "", "a\u0000b", 42]) {
      expect(isSafeSourcePath(path), String(path)).to.equal(false);
      try { await sourceFileContent({ ...opt, path }); expect.fail("should throw"); }
      catch (error) { expect(error.message).to.equal("invalid_path"); }
    }
    expect(request).to.equal(null);
    expect(isSafeSourcePath("docs/.github/README.md")).to.equal(true);
  });
});
