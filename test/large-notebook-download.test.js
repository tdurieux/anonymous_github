const { expect } = require("chai");
const { Readable, PassThrough } = require("stream");
const { once } = require("events");
const archiver = require("archiver");
const { Parse } = require("unzip-stream");
require("ts-node/register/transpile-only");
const got = require("got");
const GitHubDownload = require("../src/core/source/GitHubDownload").default;
const config = require("../src/config").default;
const { AnonymizeTransformer, ContentAnonimizer } = require("../src/core/anonymize-utils");
const { streamAnonymizedZip } = require("../src/core/zipStream");

function notebook() {
  return JSON.stringify({ nbformat: 4, nbformat_minor: 0, metadata: {}, cells: [{
    cell_type: "code", metadata: {}, execution_count: 1,
    source: ["# Alice's experiment"],
    outputs: [{ output_type: "display_data", metadata: {}, data: {
      "image/png": "AbCd".repeat(12 * 1024 * 1024),
      "text/plain": ["Alice completed the experiment"],
    } }],
  }] });
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function zip(entries) {
  const archive = archiver("zip");
  const result = collect(archive);
  for (const [name, content] of Object.entries(entries)) archive.append(content, { name });
  await archive.finalize();
  return result;
}

async function unzip(buffer) {
  const parser = Parse();
  const entries = {};
  const pending = [];
  parser.on("entry", entry => pending.push(collect(entry).then(data => { entries[entry.path] = data; })));
  const done = once(parser, "finish");
  Readable.from([buffer]).pipe(parser);
  await done;
  await Promise.all(pending);
  return entries;
}

describe("large notebook downloads", function () {
  this.timeout(15000);

  it("redacts names before and after large outputs within the anonymization deadline", async function () {
    const input = notebook();
    const transformer = new AnonymizeTransformer({ filePath: "example.ipynb", terms: ["Alice"] });
    const output = collect(transformer);
    Readable.from([Buffer.from(input)]).pipe(transformer);
    const result = JSON.parse((await output).toString());
    expect(result.cells[0].source[0]).to.equal("# XXXX-1's experiment");
    expect(result.cells[0].outputs[0].data["text/plain"][0]).to.equal("XXXX-1 completed the experiment");
    expect(result.cells[0].outputs[0].data["image/png"]).to.equal("AbCd".repeat(12 * 1024 * 1024));
  });

  it("matches RE2 boundaries and case folding for nearby literal candidates", function () {
    for (const term of ["k", "s", "Alice", "a-a", "Σ", "研究", "@Alice", "😀", "---", "@@", " "]) {
      const input = ["", " ", "é", "_", "😀", "𐐀"].flatMap(left =>
        ["", " ", "é", "_", "😀", "𐐀"].map(right => `${left}${term} ${term.toUpperCase()} K ſ${right}`)
      ).join(" ") + term.repeat(10);
      const reference = new ContentAnonimizer({ terms: [term] });
      for (const compiled of reference.compiledTerms) delete compiled.literalPrefilter;
      expect(new ContentAnonimizer({ terms: [term] }).anonymize(input)).to.equal(reference.anonymize(input));
    }
  });

  describe("ZIP streaming", function () {
    let originalStream, originalUrl, originalLimit, upstream;
    beforeEach(function () {
      originalStream = got.stream;
      originalUrl = GitHubDownload.prototype.getZipUrl;
      originalLimit = config.MAX_FILE_SIZE;
      GitHubDownload.prototype.getZipUrl = async () => ({ url: "https://example.invalid/source.zip" });
      got.stream = () => upstream;
    });
    afterEach(function () {
      got.stream = originalStream;
      GitHubDownload.prototype.getZipUrl = originalUrl;
      config.MAX_FILE_SIZE = originalLimit;
      upstream?.destroy();
    });
    const options = {
      repoId: "fixture", organization: "owner", repoName: "repo", commit: "HEAD",
      getToken: () => "test", anonymizerOptions: { filePath: "", terms: ["Alice"] },
    };

    it("completes an archive containing a large notebook and subsequent entries", async function () {
      upstream = Readable.from([await zip({ "root/example.ipynb": notebook(), "root/after.txt": "Alice" })]);
      const response = new PassThrough();
      const output = collect(response);
      await streamAnonymizedZip(options, response);
      const entries = await unzip(await output);
      expect(Object.keys(entries)).to.have.members(["example.ipynb", "after.txt"]);
      expect(entries["after.txt"].toString()).to.equal("XXXX-1");
      expect(JSON.parse(entries["example.ipynb"].toString()).cells[0].source[0]).to.equal("# XXXX-1's experiment");
    });

    it("aborts the response when an entry cannot be anonymized", async function () {
      upstream = Readable.from([await zip({ "root/large.txt": "Alice".repeat(1000) })]);
      config.MAX_FILE_SIZE = 100;
      const response = new PassThrough();
      response.resume();
      const error = once(response, "error");
      await streamAnonymizedZip(options, response);
      expect((await error)[0].message).to.contain("Text file exceeded");
      expect(response.destroyed).to.equal(true);
      expect(response.writableFinished).to.equal(false);
      expect(upstream.destroyed).to.equal(true);
    });

    it("stops downloading when the client disconnects", async function () {
      upstream = new PassThrough();
      const response = new PassThrough();
      await streamAnonymizedZip(options, response);
      const closed = once(response, "close");
      response.destroy();
      await closed;
      expect(upstream.destroyed).to.equal(true);
    });
  });
});
