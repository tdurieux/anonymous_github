const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { githubRawFileUrl } = require("../src/core/source/GitHubStream");

describe("githubRawFileUrl", function () {
  it("encodes Chinese file names for GitHub raw URLs", function () {
    const url = githubRawFileUrl(
      "owner",
      "repo",
      "abc123",
      "V 站怎么有这么多人以 PC 为荣？ - V2EX.md"
    );

    expect(url).to.equal(
      "https://github.com/owner/repo/raw/abc123/V%20%E7%AB%99%E6%80%8E%E4%B9%88%E6%9C%89%E8%BF%99%E4%B9%88%E5%A4%9A%E4%BA%BA%E4%BB%A5%20PC%20%E4%B8%BA%E8%8D%A3%EF%BC%9F%20-%20V2EX.md"
    );
  });

  it("encodes reserved characters without escaping path separators", function () {
    const url = githubRawFileUrl(
      "owner",
      "repo",
      "abc123",
      "docs/a?b#c%d.md"
    );

    expect(url).to.equal(
      "https://github.com/owner/repo/raw/abc123/docs/a%3Fb%23c%25d.md"
    );
  });
});
