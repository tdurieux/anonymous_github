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

  it("masks literal names across the retained-suffix boundary", async function () {
    const input = "xx Alice " + "z".repeat(4091);
    const options = { filePath: "a.txt", terms: ["Alice"], image: true, link: true };
    for (const split of [1, 5, 4096, input.length]) {
      const transformer = new AnonymizeTransformer(options);
      const output = collect(transformer);
      for (let i = 0; i < input.length; i += split) transformer.write(Buffer.from(input.slice(i, i + split)));
      transformer.end();
      expect(await output).to.equal(new ContentAnonimizer(options).anonymize(input));
    }
  });

  it("executes adjacent repeated patterns without backtracking", function () {
    const start = Date.now();
    const text = "a".repeat(250);
    expect(new ContentAnonimizer({ terms: ["a+a+a+a+a+a+b"] }).anonymize(text)).to.equal(text);
    expect(anonymizePath(text, ["a+a+a+a+a+a+b"])).to.equal(text);
    expect(Date.now() - start).to.be.lessThan(1000);
  });

  it("enforces the text buffering limit without emitting source bytes", async function () {
    stub(config, "MAX_FILE_SIZE", 8);
    const transformer = new AnonymizeTransformer({ filePath: "a.txt", terms: ["Alice"] });
    let emitted = false;
    transformer.on("data", () => { emitted = true; });
    const error = once(transformer, "error");
    transformer.end(Buffer.from("Alice Alice"));
    expect((await error)[0].message).to.include("exceeded");
    expect(emitted).to.equal(false);
  });

  it("does not link a recycled OAuth username to an existing GitHub identity", async function () {
    require("../src/server/routes/connection");
    const passport = require("passport");
    const UserModel = require("../src/core/model/users/users.model").default;
    let calls = 0;
    stub(UserModel, "findOne", async () => ++calls === 1 ? null : { externalIDs: { github: "old-id" }, isAdmin: true });
    stub(UserModel, "updateOne", () => { throw new Error("must not overwrite identity"); });
    const error = await new Promise(resolve => passport._strategy("github")._verify("token", "", { id: "new-id", username: "recycled" }, resolve));
    expect(error.message).to.equal("not_connected");
  });
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

  it("fails closed when a JavaScript-only pattern exceeds its execution deadline", function () {
    this.timeout(3000);
    const anonymizer = new ContentAnonimizer({ terms: ["a+a+a+a+a+a+b(?=x)"] });
    expect(() => anonymizer.anonymize("a".repeat(250))).to.throw(/timed out/);
  });

});
