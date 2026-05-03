const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { fileETag } = require("../src/server/routes/file-etag");

describe("fileETag", function () {
  const opts = { terms: ["alice"] };

  it("changes when the upstream sha changes", function () {
    expect(fileETag("sha1", "README.md", opts)).to.not.equal(
      fileETag("sha2", "README.md", opts)
    );
  });

  it("changes when the file path changes", function () {
    expect(fileETag("sha1", "README.md", opts)).to.not.equal(
      fileETag("sha1", "src/index.ts", opts)
    );
  });

  // #439 — without folding the anonymization options into the ETag, editing
  // the term list left the same URL serving stale anonymized bytes.
  it("changes when the anonymization terms change", function () {
    expect(fileETag("sha1", "README.md", { terms: ["alice"] })).to.not.equal(
      fileETag("sha1", "README.md", { terms: ["alice", "bob"] })
    );
  });

  it("changes when an anonymization toggle changes", function () {
    expect(
      fileETag("sha1", "README.md", { terms: ["alice"], image: true })
    ).to.not.equal(
      fileETag("sha1", "README.md", { terms: ["alice"], image: false })
    );
  });

  it("is stable for the same inputs", function () {
    expect(fileETag("sha1", "README.md", opts)).to.equal(
      fileETag("sha1", "README.md", opts)
    );
  });

  it("treats missing version like an empty string", function () {
    expect(fileETag(undefined, "README.md", { terms: [] })).to.equal(
      fileETag("", "README.md", { terms: [] })
    );
  });

  it("returns a quoted opaque tag", function () {
    const tag = fileETag("sha1", "README.md", { terms: [] });
    expect(tag).to.match(/^"f-[0-9a-f]{40}"$/);
  });
});
