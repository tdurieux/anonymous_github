const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { isTextFile } = require("../src/core/anonymize-utils");

describe("isTextFile", function () {
  // #493 — istextorbinary returns null for files with no extension, so a
  // bare LICENSE / COPYING / etc. used to be classified as binary and
  // never anonymized. Whitelist the conventional plaintext filenames.
  it("recognizes conventional no-extension plaintext filenames", function () {
    expect(isTextFile("LICENSE")).to.equal(true);
    expect(isTextFile("license")).to.equal(true);
    expect(isTextFile("COPYING")).to.equal(true);
    expect(isTextFile("AUTHORS")).to.equal(true);
    expect(isTextFile("README")).to.equal(true);
    expect(isTextFile("CHANGELOG")).to.equal(true);
    expect(isTextFile("NOTICE")).to.equal(true);
    expect(isTextFile("path/to/LICENSE")).to.equal(true);
  });

  it("still recognizes well-known text extensions", function () {
    expect(isTextFile("foo.txt")).to.equal(true);
    expect(isTextFile("foo.md")).to.equal(true);
    expect(isTextFile("foo.js")).to.equal(true);
  });

  it("does not classify binary files as text", function () {
    expect(isTextFile("foo.png")).to.equal(false);
    expect(isTextFile("foo.zip")).to.equal(false);
  });
});
