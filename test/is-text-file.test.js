const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { isTextFile } = require("../src/core/anonymize-utils");

describe("isTextFile", function () {
  // #493 — bare LICENSE / COPYING / etc. have no extension and no MIME, so
  // we whitelist the conventional plaintext filenames to short-circuit them
  // before falling through to content sniffing (which fails on empty files).
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

  // #735 — mime-types maps .bat to application/x-msdownload (same MIME as
  // .exe/.dll), which classified batch scripts as binary and skipped
  // anonymization entirely.
  it("recognizes Windows batch scripts as text", function () {
    expect(isTextFile("script.bat")).to.equal(true);
    expect(isTextFile("SCRIPT.BAT")).to.equal(true);
    expect(isTextFile("script.cmd")).to.equal(true);
    expect(isTextFile("path/to/build.bat")).to.equal(true);
    // .exe/.dll share the same MIME type but must stay binary
    expect(isTextFile("app.exe")).to.equal(false);
    expect(isTextFile("lib.dll")).to.equal(false);
  });

  it("recognizes jsonl-family dataset extensions", function () {
    expect(isTextFile("data.jsonl")).to.equal(true);
    expect(isTextFile("data.ndjson")).to.equal(true);
  });

  it("falls back to content sniffing for unknown extensions", function () {
    expect(
      isTextFile("foo.unknown", Buffer.from("hello world\nline two\n", "utf8"))
    ).to.equal(true);
    expect(
      isTextFile("foo.unknown", Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x05]))
    ).to.equal(false);
    const random = Buffer.alloc(512);
    for (let i = 0; i < random.length; i++) random[i] = (i * 31 + 7) % 32;
    expect(isTextFile("foo.unknown", random)).to.equal(false);
  });

  it("does not let content sniffing override a known binary extension", function () {
    expect(
      isTextFile("foo.png", Buffer.from("plain ascii pretending to be a png"))
    ).to.equal(false);
  });
});
