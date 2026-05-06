const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { filePathFromRequestUrl } = require("../src/server/routes/file");

describe("file route path decoding", function () {
  it("decodes Chinese file names from encoded URL segments", function () {
    const path = filePathFromRequestUrl(
      "/repo-id/file/V%20%E7%AB%99%E6%80%8E%E4%B9%88%E6%9C%89%E8%BF%99%E4%B9%88%E5%A4%9A%E4%BA%BA.md?v=0",
      "https",
      "anonymous.4open.science",
      "repo-id"
    );

    expect(path).to.equal("V 站怎么有这么多人.md");
  });

  it("decodes reserved characters inside a filename without treating them as URL syntax", function () {
    const path = filePathFromRequestUrl(
      "/repo-id/file/docs/a%3Fb%23c%25d.md",
      "https",
      "anonymous.4open.science",
      "repo-id"
    );

    expect(path).to.equal("docs/a?b#c%d.md");
  });

  it("keeps malformed percent sequences as literal filename text", function () {
    const path = filePathFromRequestUrl(
      "/repo-id/file/notes/100%25%20done%ZZ.md",
      "https",
      "anonymous.4open.science",
      "repo-id"
    );

    expect(path).to.equal("notes/100%25%20done%ZZ.md");
  });
});
