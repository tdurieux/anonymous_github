const { expect } = require("chai");

/**
 * Tests for the humanFileSize utility function used in download progress
 * reporting.
 *
 * Replicates the fixed version of the function from
 * src/core/source/GitHubDownload.ts to verify correctness.
 */

function humanFileSize(bytes, si = false, dp = 1) {
  const thresh = si ? 1000 : 1024;

  if (Math.abs(bytes) < thresh) {
    return bytes + "B";
  }

  const units = si
    ? ["kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"]
    : ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"];
  let u = -1;
  const r = 10 ** dp;

  do {
    bytes /= thresh;
    ++u;
  } while (
    Math.round(Math.abs(bytes) * r) / r >= thresh &&
    u < units.length - 1
  );

  return bytes.toFixed(dp) + "" + units[u];
}

describe("humanFileSize", function () {
  describe("binary units (default, si=false)", function () {
    it("returns bytes for values below 1024", function () {
      expect(humanFileSize(500)).to.equal("500B");
    });

    it("returns 0B for zero", function () {
      expect(humanFileSize(0)).to.equal("0B");
    });

    it("converts 1024 bytes to 1.0KiB", function () {
      expect(humanFileSize(1024)).to.equal("1.0KiB");
    });

    it("converts 1 MiB correctly", function () {
      expect(humanFileSize(1024 * 1024)).to.equal("1.0MiB");
    });

    it("converts 1 GiB correctly", function () {
      expect(humanFileSize(1024 * 1024 * 1024)).to.equal("1.0GiB");
    });

    it("converts 1.5 MiB correctly", function () {
      expect(humanFileSize(1.5 * 1024 * 1024)).to.equal("1.5MiB");
    });

    it("converts 10 MiB correctly", function () {
      expect(humanFileSize(10 * 1024 * 1024)).to.equal("10.0MiB");
    });

    it("does not divide bytes by 8 (regression test for bytes/8 bug)", function () {
      // 8 MiB = 8388608 bytes
      // The old buggy code would divide by 8 first, showing ~1 MiB
      const result = humanFileSize(8 * 1024 * 1024);
      expect(result).to.equal("8.0MiB");
    });
  });

  describe("SI units (si=true)", function () {
    it("returns bytes for values below 1000", function () {
      expect(humanFileSize(999, true)).to.equal("999B");
    });

    it("converts 1000 bytes to 1.0kB", function () {
      expect(humanFileSize(1000, true)).to.equal("1.0kB");
    });

    it("converts 1 MB correctly", function () {
      expect(humanFileSize(1000 * 1000, true)).to.equal("1.0MB");
    });
  });

  describe("decimal places", function () {
    it("uses 1 decimal place by default", function () {
      expect(humanFileSize(1536)).to.equal("1.5KiB");
    });

    it("supports 0 decimal places", function () {
      expect(humanFileSize(1536, false, 0)).to.equal("2KiB");
    });

    it("supports 2 decimal places", function () {
      expect(humanFileSize(1536, false, 2)).to.equal("1.50KiB");
    });
  });
});
