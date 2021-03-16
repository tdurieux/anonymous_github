var expect = require("chai").expect;
var assert = require("chai").assert;
const fs = require("fs");

const githubUtils = require("../utils/github");
const repoUtils = require("../utils/repository");
const db = require("../utils/database");

describe("Test GitHub Utils", async function() {
  describe("Download Repository", function() {
    const target = "/tmp/repo.zip";
    it("Download an exisiting repo to a folder", async function() {
      await repoUtils.downloadRepoZip(
        { fullName: "tdurieux/binance-trade-bot" },
        target
      );
      expect(fs.existsSync(target)).to.equal(true, `${target} should exist`);
      fs.unlinkSync(target);
    });
    it("Download a non-exisiting repo to a folder", async function() {
      try {
        await repoUtils.downloadRepoZip(
          { fullName: "tdurieux/missing" },
          target
        );
        fs.unlinkSync(target);
        assert.fail("Should trigger an exception");
      } catch (error) {}
    });
  });
});
