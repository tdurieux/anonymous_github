const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
require("ts-node/register/transpile-only");
const config = require("../src/config").default;
require("../src/core/storage");
const FileSystem = require("../src/core/storage/FileSystem").default;

describe("cache write error origins", function () {
  let directory, previousFolder, messages, previousWarn, previousError;
  beforeEach(function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cache-errors-"));
    previousFolder = config.FOLDER; config.FOLDER = directory;
    messages = [];
    previousWarn = console.warn; previousError = console.error;
    console.warn = (...args) => messages.push(["warn", args.join(" ")]);
    console.error = (...args) => messages.push(["error", args.join(" ")]);
  });
  afterEach(function () {
    console.warn = previousWarn; console.error = previousError;
    config.FOLDER = previousFolder;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it("warns on a source failure and preserves existing cached bytes", async function () {
    const storage = new FileSystem();
    await storage.write("repo", "file.txt", "previous");
    const input = new PassThrough();
    const failure = Object.assign(new Error("upstream missing"), { httpStatus: 404 });
    input.once("newListener", event => {
      if (event === "error") globalThis.queueMicrotask(() => input.destroy(failure));
    });
    let caught;
    try { await storage.write("repo", "file.txt", input); } catch (error) { caught = error; }
    expect(caught).to.equal(failure);
    expect(messages.some(([level, text]) => level === "warn" && text.includes("source stream failed"))).to.equal(true);
    expect(messages.some(([level, text]) => level === "error" && text.includes("write failed"))).to.equal(false);
    expect(fs.readFileSync(path.join(directory, "repo/original/file.txt"), "utf8")).to.equal("previous");
    expect(fs.readdirSync(path.join(directory, "repo/original"))).to.deep.equal(["file.txt"]);
  });
  it("keeps filesystem failures at error level", async function () {
    const storage = new FileSystem();
    await storage.mk("repo", "file.txt");
    let caught;
    try { await storage.write("repo", "file.txt", "new content"); } catch (error) { caught = error; }
    expect(caught).to.be.instanceOf(Error);
    expect(messages.some(([level, text]) => level === "error" && text.includes("write failed"))).to.equal(true);
    expect(messages.some(([level]) => level === "warn")).to.equal(false);
    expect(fs.readdirSync(path.join(directory, "repo/original"))).to.deep.equal(["file.txt"]);
  });
});
