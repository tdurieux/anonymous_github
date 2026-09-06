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

  it("propagates backpressure and cancellation through the blob probe", async function () {
    let generated = 0;
    const input = new Readable({ read() { generated++; this.push(Buffer.alloc(65536, 65)); } });
    const source = Object.create(GitHubStream.prototype);
    const output = source.resolveLfsPointer(input, "token", "file.bin");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(generated).to.be.lessThan(10);
    expect(output.readableLength).to.be.lessThan(300000);
    output.destroy();
    await new Promise(resolve => setImmediate(resolve));
    expect(input.destroyed).to.equal(true);
  });

  for (const chunkSize of [1, 200]) {
    it(`resolves LFS pointers using ${chunkSize}-byte chunks`, async function () {
      const source = Object.create(GitHubStream.prototype);
      source.downloadFileViaRaw = () => Readable.from(["complete LFS file"]);
      const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 1024\n";
      const chunks = [];
      for (let i = 0; i < pointer.length; i += chunkSize) chunks.push(Buffer.from(pointer.slice(i, i + chunkSize)));
      expect(await collect(source.resolveLfsPointer(Readable.from(chunks), "token", "file"))).to.equal("complete LFS file");
    });
  }

  for (const status of ["removing", "removed", "expiring", "expired"]) {
    it(`ignores delayed downloads for ${status} repositories`, async function () {
      stub(db, "connect", async () => {});
      stub(db, "getRepository", async () => ({ status }));
      stub(gh, "getToken", async () => { throw new Error("must not download"); });
      await require("../src/queue/processes/downloadRepository").default({ data: { repoId: "repo" } });
    });
    it(`does not let an active worker overwrite concurrent ${status}`, async function () {
      stub(db, "isConnected", true);
      const model = new RepoModel({ repoId: "repo", status: "download", anonymizeDate: new Date(1000) });
      const repo = new Repository(model); repo.protectLifecycle = true;
      stub(RepoModel, "updateOne", filter => ({ exec: async () => ({ matchedCount:
        require("sift").default(filter)({ _id: model._id, anonymizeDate: model.anonymizeDate, status }) ? 1 : 0 }) }));
      try { await repo.updateStatus("ready"); throw new Error("expected rejection"); }
      catch (error) { expect(error.message).to.equal("repository_job_cancelled"); }
      expect(repo.status).to.equal("download");
    });
  }

  it("denies another GitHub identity access through a reused coauthor username", async function () {
    const User = require("../src/core/User").default;
    const UserModel = require("../src/core/model/users/users.model").default;
    const user = new User(new UserModel({ username: "old-name", externalIDs: { github: "new-id" } }));
    stub(RepoModel, "find", filter => {
      expect(require("sift").default(filter)({ owner: "someone", coauthors: [{ username: "old-name", githubId: "old-id" }] })).to.equal(false);
      expect(require("sift").default(filter)({ owner: "someone", coauthors: [{ username: "renamed", githubId: "new-id" }] })).to.equal(true);
      return { exec: async () => [] };
    });
    expect(await user.getRepositories()).to.deep.equal([]);
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

  for (const name of ["repository-private", "gist-private", "pullRequest-private"]) {
    it(`handles rejected authentication in ${name} create routes`, async function () {
      const utils = require("../src/server/routes/route-utils");
      const router = require(`../src/server/routes/${name}`).default;
      const failure = new Error("banned"); let handled;
      stub(utils, "getUser", async () => { throw failure; });
      stub(utils, "handleError", error => { handled = error; });
      const route = router.stack.find(x => x.route?.path === "/" && x.route.methods.post).route;
      await route.stack[0].handle({ body: {} }, {});
      expect(handled).to.equal(failure);
    });
  }
  it("checks GitHub authorization before returning shared cached metadata", async function () {
    const CachedRepoModel = require("../src/core/model/repositories/repositories.model").default;
    stub(db, "isConnected", true);
    stub(CachedRepoModel, "findOne", async () => ({ name: "owner/private", branches: [{ readme: "secret" }] }));
    stub(gh, "octokit", () => ({ repos: { get: async () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); } } }));
    try {
      await require("../src/core/source/GitHubRepository").getRepositoryFromGitHub({ owner: "owner", repo: "private", accessToken: "unauthorized" });
      throw new Error("expected rejection");
    } catch (error) { expect(error.message).to.equal("token_expired"); }
  });

  it("retains truncation warnings from the source instance that fetched the tree", async function () {
    const FileModel = require("../src/core/model/files/files.model").default;
    stub(db, "isConnected", false);
    for (const method of ["exists", "deleteMany", "find"]) stub(FileModel, method, () => ({ exec: async () => method === "find" ? [] : null }));
    stub(FileModel, "insertMany", async () => []);
    const repo = new Repository(new RepoModel({ repoId: "repo", options: {} }));
    repo.computeSize = async () => {};
    Object.defineProperty(repo, "source", { get() { return { truncatedFolderList: [], async getFiles() { this.truncatedFolderList = ["private/folder"]; return []; } }; } });
    await repo.files({ force: true });
    expect(repo.model.truncatedFolders).to.deep.equal(["private/folder"]);
  });

  function response() {
    return { headers: {}, header(key, value) { this.headers[key] = value; return this; },
      contentType() { return this; }, status(value) { this.statusCode = value; return this; }, end() {}, send() {} };
  }
  function fileRoute(originalName) {
    const File = require("../src/core/AnonymizedFile").default;
    const utils = require("../src/server/routes/route-utils");
    const repo = { options: { pdf: false, image: false, terms: [] }, model: { source: { commit: "commit-1" }, options: {} }, isReady: async () => true, countView: async () => {} };
    stub(utils, "getRepo", async () => repo);
    stub(File.prototype, "originalPath", async function () { this._file = { name: originalName, path: "" }; return originalName; });
    stub(File.prototype, "sha", async () => "sha");
    stub(File.prototype, "send", async () => {});
    const handler = require("../src/server/routes/file").default.stack[0].route.stack[0].handle;
    return { repo, handler, req: { url: "/repo/file/page.txt?v=old", protocol: "https", hostname: "host", params: { repoId: "repo" }, query: { v: "old" }, headers: {} } };
  }
  it("gates PDFs using their original extension", async function () {
    const { handler, req } = fileRoute("report.pdf");
    let failure;
    stub(require("../src/server/routes/route-utils"), "handleError", error => { failure = error; });
    await handler(req, response());
    expect(failure.message).to.equal("file_not_supported");
  });
  it("sandboxes renamed HTML and invalidates stale client versions", async function () {
    const { handler, req, repo } = fileRoute("page.html");
    const first = response(); await handler(req, first);
    expect(first.headers["Content-Security-Policy"]).to.include("sandbox");
    repo.model.source.commit = "commit-2";
    req.headers["if-none-match"] = first.headers.ETag;
    const second = response(); await handler(req, second);
    expect(second.headers.ETag).not.to.equal(first.headers.ETag);
    expect(second.statusCode).not.to.equal(304);
  });
  it("decodes webview filenames and sandboxes rendered documents", async function () {
    const File = require("../src/core/AnonymizedFile").default;
    const utils = require("../src/server/routes/route-utils");
    const repo = { options: { terms: [], page: true, pageSource: { path: "/", branch: "main" }, image: true }, model: { source: { branch: "main" } } };
    stub(utils, "getRepo", async () => repo);
    let path;
    stub(File.prototype, "getFileInfo", async function () { path = this.anonymizedPath; return { name: "my file.html", path: "", size: 10 }; });
    stub(File.prototype, "send", async () => {});
    const handler = require("../src/server/routes/webview").default.stack[0].route.stack[0].handle;
    const res = response();
    await handler({ path: "/repo/my%20file.html", params: { repoId: "repo" }, headers: {} }, res);
    expect(path).to.equal("my file.html");
    expect(res.headers["Content-Security-Policy"]).to.include("sandbox");
    expect(res.headers["Content-Security-Policy"]).not.to.include("allow-same-origin");
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
