const { expect } = require("chai");
require("ts-node/register/transpile-only");

const AnonymizedFile = require("../src/core/AnonymizedFile").default;
const FileModel = require("../src/core/model/files/files.model").default;

describe("AnonymizedFile custom replacement paths", function () {
  let originalFindOne;
  let originalFind;

  beforeEach(function () {
    originalFindOne = FileModel.findOne;
    originalFind = FileModel.find;
  });

  afterEach(function () {
    FileModel.findOne = originalFindOne;
    FileModel.find = originalFind;
  });

  it("maps a custom replacement back to the original file", async function () {
    const original = {
      repoId: "repo-1",
      path: "src/secret",
      name: "index.ts",
      sha: "abc",
      size: 10,
    };
    FileModel.findOne = async () => null;
    FileModel.find = () => ({ exec: async () => [original] });

    const repository = {
      repoId: "repo-1",
      options: { terms: ["secret=>hidden"] },
      model: { truncatedFolders: [] },
      source: {},
    };
    const file = new AnonymizedFile({
      repository,
      anonymizedPath: "src/hidden/index.ts",
    });

    expect(await file.getFileInfo()).to.equal(original);
    expect(await file.originalPath()).to.equal("src/secret/index.ts");
  });
});
