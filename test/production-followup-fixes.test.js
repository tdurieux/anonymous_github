const { expect } = require("chai");
const express = require("express");
const session = require("express-session");
const { Passport } = require("passport");
const http = require("node:http");
const { Readable } = require("node:stream");
const { once } = require("node:events");
const { randomBytes } = require("node:crypto");
const { URL } = require("node:url");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const archiver = require("archiver");
const got = require("got");
require("ts-node/register/transpile-only");
const { serverOptions } = require("../src/server/server-options");
const { serializeError } = require("../src/core/logger");
const { repositoryFailureStatus } = require("../src/core/repository-failure-status");
const AnonymousError = require("../src/core/AnonymousError").default;
const github = require("../src/core/GitHubUtils");
const GitHubStream = require("../src/core/source/GitHubStream").default;
const FileSystem = require("../src/core/storage/FileSystem").default;
const S3 = require("../src/core/storage/S3").default;
const config = require("../src/config").default;
const { AnonymizeTransformer } = require("../src/core/anonymize-utils");
const { streamAnonymizedZip } = require("../src/core/zipStream");
const { classifyContentMiss } = require("../src/core/source/github-content-miss");
const storage = require("../src/core/storage").default;

function request(server, path, method) {
  return new Promise((resolve, reject) => {
    http.request({ host: "127.0.0.1", port: server.address().port, path, method }, res => {
      res.resume(); res.once("end", () => resolve({ status: res.statusCode, headers: res.headers }));
      res.once("error", reject);
    }).once("error", reject).end();
  });
}

describe("production follow-up fixes", function () {
  this.timeout(10000);
  const restores = [];
  function stub(object, key, value) {
    const previous = object[key]; object[key] = value; restores.push(() => { object[key] = previous; });
  }
  afterEach(() => restores.splice(0).reverse().forEach(restore => restore()));

  it("answers OPTIONS * before sessions while preserving route OPTIONS and authentication", async () => {
    const app = express(), passport = new Passport();
    let sessionRequests = 0;
    app.use(serverOptions);
    app.use((_req, _res, next) => { sessionRequests++; next(); });
    app.use(session({ secret: "test-secret", resave: false, saveUninitialized: false }));
    app.use(passport.initialize()); app.use(passport.session());
    app.get("/protected", (req, res) => res.sendStatus(req.isAuthenticated() ? 200 : 401));
    const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    try {
      const global = await request(server, "*", "OPTIONS");
      expect(global.status).to.equal(204); expect(global.headers.allow).to.include("OPTIONS");
      expect(global.headers["set-cookie"]).to.equal(undefined); expect(sessionRequests).to.equal(0);
      expect((await request(server, "*", "GET")).status).to.equal(400); expect(sessionRequests).to.equal(0);
      const route = await request(server, "/protected", "OPTIONS");
      expect(route.status).to.equal(200); expect(route.headers.allow).to.equal("GET, HEAD");
      expect((await request(server, "/protected", "GET")).status).to.equal(401);
      expect(sessionRequests).to.equal(2);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });

  function source(getTree, getRepo = async () => ({})) {
    stub(github, "waitForTokenGate", async () => {});
    stub(github, "octokit", () => ({ git: { getTree }, repos: { get: getRepo } }));
    return new GitHubStream({ repoId: "followup", organization: "owner", repoName: "repo", commit: "pinned", getToken: () => "test-token" });
  }
  const invalidObject = () => Object.assign(Error("Invalid object requested"), {
    status: 422, response: { data: { message: "Invalid object requested. SHA must identify a commit or a tree." } },
  });
  for (const [status, code, responseStatus] of [[401, "token_expired", 401], [403, "repo_not_accessible", 403],
    [404, "commit_not_found", 404], [409, "repo_empty", 409], [500, "github_unavailable", 502],
    [503, "github_unavailable", 502], [422, "github_unavailable", 502], [undefined, "github_unavailable", 502]]) {
    it(`classifies tree failure ${status} without calling it a missing repository`, async () => {
      const upstream = Object.assign(Error("upstream failure"), { status });
      const s = source(async () => { throw upstream; });
      const error = await s.getFiles().catch(error => error);
      expect(error.message).to.equal(code); expect(error.httpStatus).to.equal(responseStatus);
      expect(error.cause).to.equal(upstream); expect(s.data.commit).to.equal("pinned");
    });
  }
  it("reports an invalid tree revision as a missing commit without changing the pinned snapshot", async () => {
    const s = source(async () => { throw invalidObject(); });
    const error = await s.getFiles().catch(error => error);
    expect(error.message).to.equal("commit_not_found"); expect(error.httpStatus).to.equal(404);
    expect(s.data.commit).to.equal("pinned"); expect(repositoryFailureStatus(error.message)).to.equal(404);
  });
  it("preserves quota errors from both the gate and tree request", async () => {
    const quota = new AnonymousError("github_rate_limit_exceeded", { httpStatus: 429 });
    const s = source(async () => { throw quota; });
    expect(await s.getFiles().catch(error => error)).to.equal(quota);
    github.waitForTokenGate = async () => { throw quota; };
    expect(await s.getFiles().catch(error => error)).to.equal(quota);
    const delay = new github.RateLimitDelayError(Date.now() + 60000, "quota-key");
    github.waitForTokenGate = async () => { throw delay; };
    expect(await s.getFiles().catch(error => error)).to.equal(delay);
  });
  it("classifies failures while traversing a truncated tree too", async () => {
    const s = source(async ({ tree_sha }) => {
      if (tree_sha === "pinned") return { data: { truncated: true, tree: [{ type: "tree", path: "folder", sha: "child" }] } };
      throw Object.assign(Error("GitHub offline"), { status: 503 });
    });
    const error = await s.getFiles().catch(error => error);
    expect(error.message).to.equal("github_unavailable"); expect(error.httpStatus).to.equal(502);
  });
  it("maps an empty repository consistently after its failure is persisted", () => {
    expect(repositoryFailureStatus("repo_empty")).to.equal(409);
  });
  it("serializes HTTP errors without invoking a deprecated code getter", () => {
    let reads = 0;
    const error = Object.assign(Error("GitHub error"), { status: 422 });
    Object.defineProperty(error, "code", { get() { reads++; throw Error("deprecated getter invoked"); } });
    expect(serializeError(error)).to.include({ status: 422, message: "GitHub error" });
    expect(reads).to.equal(0);
    expect(serializeError(Object.assign(Error("reset"), { code: "ECONNRESET" }))).to.include({ code: "ECONNRESET" });
  });

  it("coalesces content-miss probes across paths and expires them so restored access is retried", async () => {
    let now = Date.now(), repoCalls = 0, commitCalls = 0;
    stub(Date, "now", () => now); stub(github, "waitForTokenGate", async () => {});
    stub(github, "octokit", () => ({ repos: {
      get: async () => { repoCalls++; }, getCommit: async options => { expect(options.mediaType.format).to.equal("sha"); commitCalls++; },
    } }));
    const data = { repoId: "miss-coalescing", organization: "owner", repoName: "repo", commit: "pinned" };
    expect(await Promise.all(Array.from({ length: 20 }, () => classifyContentMiss(data, "a"))))
      .to.deep.equal(Array(20).fill("file_not_found"));
    expect(await classifyContentMiss(data, "a")).to.equal("file_not_found");
    expect(repoCalls).to.equal(1); expect(commitCalls).to.equal(1);
    await classifyContentMiss(data, "b"); expect(repoCalls).to.equal(2);
    await classifyContentMiss({ ...data, commit: "new" }, "a"); expect(repoCalls).to.equal(3);
    await classifyContentMiss({ ...data, cacheRevision: "new" }, "a"); expect(repoCalls).to.equal(4);
    now += 30001; await classifyContentMiss(data, "a"); expect(repoCalls).to.equal(5);
  });
  for (const stage of ["repository", "commit"]) {
    it(`reports a missing ${stage} instead of a missing file`, async () => {
      let commits = 0;
      stub(github, "waitForTokenGate", async () => {});
      stub(github, "octokit", () => ({ repos: {
        get: async () => { if (stage === "repository") throw Object.assign(Error("missing"), { status: 404 }); },
        getCommit: async () => { commits++; throw Object.assign(Error("missing"), { status: 404 }); },
      } }));
      const data = { repoId: `missing-${stage}`, organization: "owner", repoName: "repo", commit: "pinned" };
      expect(await classifyContentMiss(data, "a")).to.equal(stage === "repository" ? "repo_not_found" : "commit_not_found");
      expect(commits).to.equal(stage === "repository" ? 0 : 1);
    });
  }
  for (const status of [401, 403, 422, 503]) {
    it(`does not cache a content-probe ${status} failure as a missing file`, async () => {
      let calls = 0;
      stub(github, "waitForTokenGate", async () => {});
      stub(github, "octokit", () => ({ repos: { get: async () => { calls++; throw Object.assign(Error("failed"), { status }); } } }));
      const data = { repoId: `probe-failure-${status}`, organization: "owner", repoName: "repo", commit: "pinned" };
      for (let i = 0; i < 2; i++) {
        const error = await classifyContentMiss(data, "a").catch(error => error);
        expect(error.httpStatus).to.equal(status === 401 || status === 403 ? status : 502);
      }
      expect(calls).to.equal(2);
    });
  }
  it("recognizes the GitHub invalid-commit response without retrying with HEAD", async () => {
    let ref;
    stub(github, "waitForTokenGate", async () => {});
    stub(github, "octokit", () => ({ repos: {
      get: async () => {}, getCommit: async options => {
        ref = options.ref; throw Object.assign(Error("missing"), { status: 422, response: { data: { message: "No commit found for SHA: pinned" } } });
      },
    } }));
    expect(await classifyContentMiss({ repoId: "invalid-commit-probe", organization: "owner", repoName: "repo", commit: "pinned" }, "a"))
      .to.equal("commit_not_found");
    expect(ref).to.equal("pinned");
  });

  function rawFallback(downloadUrl, content) {
    const calls = [];
    stub(github, "waitForTokenGate", async () => {});
    stub(github, "octokit", () => ({ repos: { getContent: async options => {
      expect(options).to.include({ owner: "owner", repo: "repo", path: "file.bin", ref: "pinned" });
      return { data: { type: "file", download_url: downloadUrl } };
    } } }));
    stub(got, "stream", (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return new Readable({ read() { this.destroy(Object.assign(Error("private web 404"), { response: { statusCode: 404 } })); } });
      return Readable.from(Array.isArray(content) ? content : [content]);
    });
    const s = new GitHubStream({ repoId: "private-fallback", organization: "owner", repoName: "repo", commit: "pinned", getToken: () => "owner-secret" });
    return { stream: s.downloadFileViaRaw("owner-secret", "file.bin"), calls };
  }
  it("recovers an accessible private file from the API download URL without forwarding the owner token", async () => {
    const url = "https://raw.githubusercontent.com/owner/repo/pinned/file.bin?token=short-lived";
    const { stream, calls } = rawFallback(url, Buffer.from("actual content"));
    expect((await collect(stream)).toString()).to.equal("actual content");
    expect(calls).to.have.length(2); expect(calls[1].url).to.equal(url);
    expect(calls[1].options.headers).to.equal(undefined);
    expect(() => calls[1].options.hooks.beforeRedirect[0]({ url: new URL("https://attacker.test/file") })).to.throw("upstream_error");
    expect(serializeError(Object.assign(Error("failed"), { response: { url } })).url).not.to.include("short-lived");
  });
  for (const url of ["http://raw.githubusercontent.com/file", "https://attacker.test/file", "https://owner-secret@raw.githubusercontent.com/file"]) {
    it(`rejects an unsafe contents download URL ${new URL(url).hostname}`, async () => {
      const { stream, calls } = rawFallback(url, Buffer.from("should never be read"));
      const error = await collect(stream).catch(error => error);
      expect(error.message).to.equal("upstream_error"); expect(error.httpStatus).to.equal(502); expect(calls).to.have.length(1);
    });
  }
  for (const mode of ["short", "long", "fragmented"]) {
    it(`does not serve a ${mode} unresolved LFS pointer as file content`, async () => {
      const extension = mode === "short" ? "" : "ext-0-test sha256:" + "b".repeat(64) + "\n";
      const pointer = Buffer.from("version https://git-lfs.github.com/spec/v1\n" + extension + "oid sha256:" + "a".repeat(64) + "\nsize 10\n");
      const chunks = mode === "fragmented" ? [pointer.subarray(0, 20), pointer.subarray(20, 150), pointer.subarray(150)] : pointer;
      const { stream } = rawFallback("https://raw.githubusercontent.com/owner/repo/pinned/file.bin", chunks);
      const error = await collect(stream).catch(error => error);
      expect(error.message).to.equal("upstream_error"); expect(error.httpStatus).to.equal(502);
    });
  }
  for (const mode of ["single", "fragmented"]) {
    it(`resolves a long blob LFS pointer with ${mode} delivery instead of forwarding its text`, async () => {
      const pointer = Buffer.from("version https://git-lfs.github.com/spec/v1\next-0-test sha256:" + "b".repeat(64) + "\noid sha256:" + "a".repeat(64) + "\nsize 10\n");
      const s = new GitHubStream({ repoId: "long-lfs", organization: "owner", repoName: "repo", commit: "pinned", getToken: () => "token" });
      let downloads = 0;
      s.downloadFileViaRaw = () => { downloads++; return Readable.from(["resolved file"]); };
      const chunks = mode === "fragmented" ? [pointer.subarray(0, 20), pointer.subarray(20, 150), pointer.subarray(150)] : [pointer];
      expect((await collect(s.resolveLfsPointer(Readable.from(chunks), "token", "file.bin"))).toString()).to.equal("resolved file");
      expect(downloads).to.equal(1);
    });
  }
  it("releases cancelled gate timers and private streams without retaining process handles", function () {
    this.timeout(20000);
    const result = spawnSync(process.execPath, [path.join(__dirname, "fixtures/github-gate-cancellation.js")], {
      timeout: 15000, encoding: "utf8", env: { ...process.env, NODE_ENV: "test", GITHUB_APP_ENABLED: "false", REDIS_HOSTNAME: "127.0.0.1", REDIS_PORT: "1" },
    });
    expect(result.error, result.stderr).to.equal(undefined);
    expect(result.status, result.stderr + result.stdout).to.equal(0);
    expect(result.stdout).to.include("gate cancellations released");
  });
  it("keeps public raw misses off the contents API", async () => {
    stub(github, "octokit", () => { throw Error("unexpected anonymous REST request"); });
    stub(got, "stream", () => new Readable({ read() { this.destroy(Object.assign(Error("missing"), { response: { statusCode: 404 } })); } }));
    const s = new GitHubStream({ repoId: "public-raw", organization: "owner", repoName: "repo", commit: "pinned", getToken: () => "" });
    const error = await collect(s.downloadFileViaRaw("", "file.bin")).catch(error => error);
    expect(error.response.statusCode).to.equal(404);
  });
  it("does not start a private download after cancellation during the contents lookup", async () => {
    let resolveMetadata, started, calls = 0;
    const metadata = new Promise(resolve => { resolveMetadata = resolve; });
    const lookupStarted = new Promise(resolve => { started = resolve; });
    stub(github, "waitForTokenGate", async () => {});
    stub(github, "octokit", () => ({ repos: { getContent: async () => { started(); return metadata; } } }));
    stub(got, "stream", () => {
      calls++; return new Readable({ read() { this.destroy(Object.assign(Error("missing"), { response: { statusCode: 404 } })); } });
    });
    const s = new GitHubStream({ repoId: "cancel-private", organization: "owner", repoName: "repo", commit: "pinned", getToken: () => "token" });
    const input = s.downloadFileViaRaw("token", "file.bin");
    const collected = collect(input).catch(error => error);
    await lookupStarted; input.destroy();
    resolveMetadata({ data: { type: "file", download_url: "https://raw.githubusercontent.com/owner/repo/pinned/file.bin" } });
    await collected; expect(calls).to.equal(1);
  });
  for (const mode of ["raw", "lfs"]) {
    it(`destroys a pending ${mode} upstream immediately when its consumer cancels`, async () => {
      const { PassThrough } = require("node:stream");
      const upstream = new PassThrough();
      let started;
      const ready = new Promise(resolve => { started = resolve; });
      stub(got, "stream", () => { started(); return upstream; });
      const s = new GitHubStream({ repoId: "pending-raw", organization: "owner", repoName: "repo", commit: "pinned", getToken: () => "token" });
      const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 10\n";
      const input = mode === "raw" ? s.deferredRawDownload("token", "file.bin")
        : s.resolveLfsPointer(Readable.from([pointer]), "token", "file.bin");
      const collected = collect(input).catch(error => error);
      await ready; input.destroy();
      expect(upstream.destroyed).to.equal(true);
      await collected;
    });
  }
  it("closes a real upstream HTTP socket when a nested raw stream is cancelled", async () => {
    let respond, closed;
    const responseStarted = new Promise(resolve => { respond = resolve; });
    const socketClosed = new Promise(resolve => { closed = resolve; });
    const server = http.createServer((req, res) => {
      req.socket.once("close", closed); res.write("partial content");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const originalStream = got.stream;
    stub(got, "stream", () => {
      const input = originalStream(`http://127.0.0.1:${server.address().port}`, { retry: { limit: 0 } });
      input.once("response", respond); return input;
    });
    const s = new GitHubStream({ repoId: "cancel-socket", organization: "owner", repoName: "repo", commit: "pinned", getToken: () => "token" });
    const input = s.deferredRawDownload("token", "file.bin");
    const collected = collect(input).catch(error => error);
    try {
      await responseStarted; input.destroy();
      await socketClosed; await collected;
    } finally { input.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  it("avoids file downloads for a known unavailable source and retries after the short TTL", async () => {
    let now = Date.now(), attempts = 0;
    stub(Date, "now", () => now); stub(github, "waitForTokenGate", async () => {});
    stub(github, "octokit", () => ({ repos: { get: async () => { throw Object.assign(Error("missing repository"), { status: 404 }); } } }));
    stub(storage, "fileInfo", async () => { throw Object.assign(Error("missing cache"), { code: "ENOENT" }); });
    const s = new GitHubStream({ repoId: "source-miss-shortcut", organization: "owner", repoName: "repo", commit: "pinned", getToken: () => "token" });
    s.downloadWithFallback = async () => { attempts++; throw Object.assign(Error("missing"), { response: { statusCode: 404 } }); };
    for (const path of ["first", "second", "third"]) {
      const error = await s.getFileContentCache(path, s.data.repoId, () => ({ sha: path })).catch(error => error);
      expect(error.message).to.equal("repo_not_found"); expect(error.httpStatus).to.equal(404);
    }
    expect(attempts).to.equal(1);
    now += 30001;
    await s.getFileContentCache("fourth", s.data.repoId, () => ({ sha: "fourth" })).catch(() => {});
    expect(attempts).to.equal(2);
  });

  // Read the central directory to check the actual compression methods,
  // rather than just asserting the options passed to archiver.
  function compressionMethods(zip) {
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).to.equal(0x06054b50);
    const methods = {};
    let offset = zip.readUInt32LE(end + 16);
    for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
      expect(zip.readUInt32LE(offset)).to.equal(0x02014b50);
      const nameLength = zip.readUInt16LE(offset + 28);
      const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString();
      methods[name] = zip.readUInt16LE(offset + 10);
      offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    }
    return methods;
  }
  async function collect(input) {
    const chunks = []; for await (const chunk of input) chunks.push(chunk); return Buffer.concat(chunks);
  }
  async function unpack(zip) {
    const files = {}, entries = [], parser = require("unzip-stream").Parse();
    parser.on("entry", entry => { entries.push(collect(entry).then(body => { files[entry.path] = body; })); });
    const done = once(parser, "finish"); Readable.from([zip]).pipe(parser);
    await done; await Promise.all(entries); return files;
  }
  const binary = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), randomBytes(128 * 1024)]);
  const contents = { "private.PNG": binary, "README.md": Buffer.from("private source content"),
    "figure.svg": Buffer.from('<svg><text>private</text></svg>') };
  const options = { terms: ["private"], image: true, pdf: true, link: true };
  for (const backend of ["filesystem", "s3", "github"]) {
    it(`avoids recompressing binary assets in ${backend} ZIPs and still anonymizes text`, async () => {
      let zip;
      if (backend === "github") {
        const fixture = archiver("zip");
        const collected = collect(fixture);
        for (const [name, body] of Object.entries(contents)) fixture.append(body, { name: `repo/${name}` });
        await fixture.finalize(); const input = await collected;
        stub(got, "stream", () => Readable.from([input]));
        const { PassThrough } = require("node:stream");
        const response = new PassThrough(); const output = collect(response);
        await streamAnonymizedZip({ repoId: "test", organization: "owner", repoName: "public", commit: "pinned",
          getToken: () => "", anonymizerOptions: options }, response);
        zip = await output;
      } else {
        if (backend === "s3") stub(config, "S3_BUCKET", "test-bucket");
        const storage = backend === "filesystem" ? new FileSystem() : new S3();
        const names = Object.keys(contents);
        storage.read = async (_repo, name) => Readable.from([contents[name]]);
        if (backend === "filesystem") storage.listFiles = async () => names.map(name => ({ name, path: "", size: contents[name].length }));
        else {
          storage.client = () => ({ listObjectsV2: async () => ({ Contents: names.map(name => ({ Key: storage.repoPath("test") + name })) }) });
        }
        zip = await collect(await storage.archive("test", "", {
          fileTransformer: name => new AnonymizeTransformer({ ...options, filePath: name }),
        }));
      }
      const methods = compressionMethods(zip), files = await unpack(zip);
      const binaryName = backend === "github" ? "XXXX-1.PNG" : "private.PNG";
      expect(methods[binaryName]).to.equal(0); expect(files[binaryName]).to.deep.equal(binary);
      expect(methods["README.md"]).to.equal(8); expect(files["README.md"].toString()).to.equal("XXXX-1 source content");
      expect(methods["figure.svg"]).to.equal(8); expect(files["figure.svg"].toString()).to.include("XXXX-1");
    });
  }
});
