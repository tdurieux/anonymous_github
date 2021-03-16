var expect = require("chai").expect;
var assert = require("chai").assert;
const fs = require("fs");

const githubUtils = require("../utils/github");
const fileUtils = require("../utils/file");
const repoUtils = require("../utils/repository");
const db = require("../utils/database");

describe("Test Files Utils", async function() {
  describe("List all files", function() {
    it("Get all file from repo with more than 1000 files", async function() {
      const fullName = "TQRG/BugSwarm";
      await fileUtils.getTree({ fullName });
    });
  });
});
