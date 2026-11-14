const { expect } = require("chai");
require("ts-node/register/transpile-only");
const github = require("../src/core/GitHubUtils");
const { repositoryPickerPage } = require("../src/core/github-repository-picker");

describe("repository picker bounded pages", () => {
  let original;
  beforeEach(() => { original = github.octokit; });
  afterEach(() => { github.octokit = original; });
  it("fetches only one small upstream page for browsing", async () => {
    let calls = 0;
    github.octokit = token => ({ request: async (route, params) => {
      calls++;
      expect(token).to.equal("private-token");
      expect(params).to.include({ page: 2, per_page: 20, sort: "full_name" });
      return { data: [{ id: 21, full_name: "org/repo" }], headers: {} };
    } });
    expect(await repositoryPickerPage("private-token", 20)).to.deep.equal({
      items: [{ id: 21, fullName: "org/repo" }], nextCursor: null,
    });
    expect(calls).to.equal(1);
  });
  it("searches case-insensitively and resumes without skipping matches", async () => {
    github.octokit = () => ({ request: async () => ({
      data: Array.from({ length: 100 }, (_, id) => ({ id, full_name: `Org/${id % 2 ? "other" : "Match"}-${id}` })),
      headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' },
    }) });
    const first = await repositoryPickerPage("token", 0, "org/match");
    expect(first.items).to.have.length(20);
    expect(first.nextCursor).to.equal(39);
    const second = await repositoryPickerPage("token", first.nextCursor, "org/match");
    expect(second.items[0].id).to.equal(40);
    expect(second.items).to.have.length(20);
  });
  it("returns a continuation for an empty search batch, not a false end", async () => {
    github.octokit = () => ({ request: async () => ({
      data: Array.from({ length: 100 }, (_, id) => ({ id, full_name: `org/repo-${id}` })),
      headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' },
    }) });
    expect(await repositoryPickerPage("token", 0, "missing")).to.deep.equal({ items: [], nextCursor: 100 });
  });
  it("propagates upstream failures so the UI can retry", async () => {
    github.octokit = () => ({ request: async () => { throw new Error("rate limit"); } });
    try { await repositoryPickerPage("token"); throw new Error("unexpected success"); }
    catch (error) { expect(error.message).to.equal("rate limit"); }
  });
});
