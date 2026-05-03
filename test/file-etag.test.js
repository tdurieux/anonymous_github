const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { fileETag } = require("../src/server/routes/file-etag");

describe("fileETag", function () {
  it("changes when the upstream sha changes", function () {
    const opts = { terms: ["alice"] };
    expect(fileETag("sha1", opts)).to.not.equal(fileETag("sha2", opts));
  });

  // #439 — without folding the anonymization options into the ETag, editing
  // the term list left the same URL serving stale anonymized bytes.
  it("changes when the anonymization terms change", function () {
    const a = fileETag("sha1", { terms: ["alice"] });
    const b = fileETag("sha1", { terms: ["alice", "bob"] });
    expect(a).to.not.equal(b);
  });

  it("changes when an anonymization toggle changes", function () {
    const a = fileETag("sha1", { terms: ["alice"], image: true });
    const b = fileETag("sha1", { terms: ["alice"], image: false });
    expect(a).to.not.equal(b);
  });

  it("is stable for the same inputs", function () {
    const opts = { terms: ["alice", "bob"], image: true };
    expect(fileETag("sha1", opts)).to.equal(fileETag("sha1", opts));
  });

  it("treats missing version like an empty string", function () {
    const opts = { terms: [] };
    expect(fileETag(undefined, opts)).to.equal(fileETag("", opts));
  });

  it("returns a quoted opaque tag", function () {
    const tag = fileETag("sha1", { terms: [] });
    expect(tag).to.match(/^"f-[0-9a-f]{40}"$/);
  });
});
