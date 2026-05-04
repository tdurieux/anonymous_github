const { expect } = require("chai");
const { Readable } = require("stream");

// Standalone test of the LFS-pointer detection shape used in
// GitHubStream#resolveLfsPointer. We can't easily import that method (it's
// private and the file pulls in heavy GitHub plumbing), so this mirrors the
// detection logic to confirm the head-bytes check.

const LFS_PREFIX = "version https://git-lfs.github.com/spec/";

function isLfsPointer(buf) {
  return (
    buf.length >= LFS_PREFIX.length &&
    buf.toString("utf8", 0, LFS_PREFIX.length) === LFS_PREFIX
  );
}

describe("LFS pointer detection (#95)", function () {
  it("recognizes the standard pointer prefix", function () {
    const pointer = Buffer.from(
      "version https://git-lfs.github.com/spec/v1\n" +
        "oid sha256:abc123\nsize 12345\n"
    );
    expect(isLfsPointer(pointer)).to.equal(true);
  });

  it("doesn't false-positive on plain text starting with 'version'", function () {
    const fake = Buffer.from(
      "version 1.2.3\nA short release notes file mentioning git-lfs.\n"
    );
    expect(isLfsPointer(fake)).to.equal(false);
  });

  it("doesn't false-positive on binary headers", function () {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, ...new Array(100).fill(0)]);
    expect(isLfsPointer(elf)).to.equal(false);
  });

  it("handles short streams below the prefix length", function () {
    expect(isLfsPointer(Buffer.from("vers"))).to.equal(false);
  });
});
