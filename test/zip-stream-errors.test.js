const { expect } = require("chai");
const { Readable, PassThrough } = require("stream");
const { setImmediate } = require("timers");
const { once } = require("events");
const vm = require("vm");
const got = require("got");
const archiver = require("archiver");
require("ts-node/register/transpile-only");
const GitHubDownload = require("../src/core/source/GitHubDownload").default;
const { AnonymizeTransformer } = require("../src/core/anonymize-utils");
const { streamAnonymizedZip } = require("../src/core/zipStream");

async function fixture() {
  const zip = archiver("zip");
  const chunks = [];
  zip.on("data", chunk => chunks.push(chunk));
  const finished = once(zip, "end");
  zip.append("private source content", { name: "repo/README.md" });
  await zip.finalize();
  await finished;
  return Buffer.concat(chunks);
}

describe("ZIP stream errors", function () {
  it("finishes a valid ZIP with anonymized file content", async function () {
    const input = await fixture();
    const previous = { stream: got.stream, zip: GitHubDownload.prototype.getZipUrl };
    const response = new PassThrough();
    const parser = require("unzip-stream").Parse();
    const files = [];
    const entries = [];
    parser.on("entry", entry => {
      const chunks = [];
      entry.on("data", chunk => chunks.push(chunk));
      entries.push(once(entry, "end").then(() => files.push({ name: entry.path, content: Buffer.concat(chunks).toString() })));
    });
    const finished = once(parser, "finish");
    response.pipe(parser);
    try {
      GitHubDownload.prototype.getZipUrl = async () => ({ url: "https://example.test/archive.zip" });
      got.stream = () => Readable.from([input]);
      await streamAnonymizedZip({
        repoId: "test", organization: "owner", repoName: "public", commit: "abc",
        getToken: () => "", anonymizerOptions: { terms: ["private"], image: true, link: true },
      }, response);
      await finished;
      await Promise.all(entries);
      expect(files).to.deep.equal([{ name: "README.md", content: "XXXX-1 source content" }]);
    } finally {
      got.stream = previous.stream;
      GitHubDownload.prototype.getZipUrl = previous.zip;
      response.destroy();
    }
  });

  it("aborts a download on an asynchronous anonymization timeout without crashing", async function () {
    const input = await fixture();
    const previous = { stream: got.stream, zip: GitHubDownload.prototype.getZipUrl, flush: AnonymizeTransformer.prototype._flush };
    const response = new PassThrough();
    const errors = [];
    const chunks = [];
    response.on("error", error => errors.push(error));
    response.on("data", chunk => chunks.push(chunk));
    const closed = new Promise(resolve => response.once("close", resolve));
    const timeout = vm.runInNewContext('Object.assign(new Error("Script execution timed out after 1000ms"), { code: "ERR_SCRIPT_EXECUTION_TIMEOUT" })');
    try {
      GitHubDownload.prototype.getZipUrl = async () => ({ url: "https://example.test/archive.zip" });
      got.stream = () => Readable.from([input]);
      // VM timeout errors come from another realm and can arrive after the ZIP
      // parser finishes, while archiver is still consuming the entry stream.
      AnonymizeTransformer.prototype._flush = function (callback) {
        setImmediate(() => callback(timeout));
      };
      await streamAnonymizedZip({
        repoId: "test", organization: "owner", repoName: "public", commit: "abc",
        getToken: () => "", anonymizerOptions: { terms: ["private"], image: true, link: true },
      }, response);
      await closed;
      await new Promise(resolve => setImmediate(resolve));
      expect(response.destroyed).to.equal(true);
      expect(errors).to.have.length(1);
      expect(errors[0].code).to.equal("ERR_SCRIPT_EXECUTION_TIMEOUT");
      expect(Buffer.concat(chunks).includes(Buffer.from("private source content"))).to.equal(false);
    } finally {
      got.stream = previous.stream;
      GitHubDownload.prototype.getZipUrl = previous.zip;
      AnonymizeTransformer.prototype._flush = previous.flush;
      response.destroy();
    }
  });
});
