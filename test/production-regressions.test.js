const { setTimeout, setImmediate } = require("timers");
const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { Readable } = require("stream");
const { once } = require("events");
const config = require("../src/config").default;
const db = require("../src/server/database");
const gh = require("../src/core/GitHubUtils");
const RepoModel = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const Repository = require("../src/core/Repository").default;
const GitHubStream = require("../src/core/source/GitHubStream").default;
const { ContentAnonimizer, AnonymizeTransformer, anonymizePath } = require("../src/core/anonymize-utils");

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

describe("production regressions", function () {
  const restores = [];
  function stub(object, key, value) {
    const old = object[key]; restores.push(() => { object[key] = old; }); object[key] = value;
  }
  afterEach(() => { while (restores.length) restores.pop()(); });
  it("omits an upstream length when later text is rewritten", async function () {
    const File = require("../src/core/AnonymizedFile").default;
    stub(config, "STREAMER_ENTRYPOINT", "");
    const repo = new Repository(new RepoModel({ repoId: "repo", options: { terms: ["Alice"], image: true, link: true }, source: {} }));
    const file = new File({ repository: repo, anonymizedPath: "file.txt" });
    const input = "z".repeat(9000) + " Alice";
    file._file = { name: "file.txt", path: "", size: input.length };
    file.content = async () => Readable.from([Buffer.from(input.slice(0, 5000)), Buffer.from(input.slice(5000))]);
    const res = new (require("stream").PassThrough)();
    const headers = {};
    res.header = (key, value) => { headers[key] = value; return res; };
    res.contentType = () => res;
    const output = collect(res);
    await file.send(res);
    expect(await output).to.equal("z".repeat(9000) + " XXXX-1");
    expect(headers).not.to.have.property("Content-Length");
  });

});
