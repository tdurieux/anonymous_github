const { expect } = require("chai");
const { Readable, PassThrough } = require("node:stream");
const { once } = require("node:events");
const { setImmediate } = require("node:timers");
const archiver = require("archiver");
const got = require("got");
require("ts-node/register/transpile-only");
const utils = require("../src/core/GitHubUtils");
const { expandSubmodules, submoduleRepository, validateMounts, MAX_SUBMODULES, MAX_SUBMODULE_ENTRIES } = require("../src/core/source/github-submodules");
const GitHubStream = require("../src/core/source/GitHubStream").default;
const FileModel = require("../src/core/model/files/files.model").default;
const storage = require("../src/core/storage").default;
const { streamAnonymizedZip } = require("../src/core/zipStream");
const config = require("../src/config").default;
const sha = "a".repeat(40), blob = "b".repeat(40);
const parent = { repoId: "submodule-test", organization: "parent", repoName: "repo", commit: "c".repeat(40), getToken: () => "parent-private-token" };
const upstream = { organization: "child", repoName: "public", commit: sha, path: "src/Alice.txt" };
const mount = () => new FileModel({ repoId: parent.repoId, name: "dependency", path: "vendor", sha, submodule: "unsupported" });

async function zip(entries) {
  const archive = archiver("zip"); const chunks = [];
  archive.on("data", chunk => chunks.push(chunk)); const done = once(archive, "end");
  for (const [name, content] of Object.entries(entries)) archive.append(content, { name });
  await archive.finalize(); await done; return Buffer.concat(chunks);
}

async function readZip(options) {
  const response = new PassThrough(); const parser = require("unzip-stream").Parse();
  const entries = [], files = {};
  parser.on("entry", entry => {
    const chunks = []; entry.on("data", chunk => chunks.push(chunk));
    entries.push(once(entry, "end").then(() => { files[entry.path] = Buffer.concat(chunks).toString(); }));
  });
  response.pipe(parser); const done = once(parser, "finish");
  await streamAnonymizedZip(options, response); await done; await Promise.all(entries);
  return files;
}

const zipOptions = { ...parent, getToken: () => "", anonymizerOptions: { terms: ["Alice"], image: true, link: true },
  submodules: [{ organization: "child", repoName: "public", commit: sha, path: "vendor/dependency" }] };

describe("public GitHub submodules", function () {
  this.timeout(10000);
  const restore = [];
  function stub(object, key, value) { const previous = object[key]; object[key] = value; restore.push(() => { object[key] = previous; }); }
  afterEach(() => restore.splice(0).reverse().forEach(fn => fn()));
  beforeEach(() => stub(utils, "waitForTokenGate", async () => {}));

  function api(tree = [{ path: "src/Alice.txt", type: "blob", sha: blob, size: 5 }], options = {}) {
    const calls = [];
    stub(utils, "octokit", token => ({
      repos: { getContent: async args => {
        calls.push({ method: "contents", token, ...args });
        return { data: { submodule_git_url: options.url || "https://github.com/child/public.git", sha } };
      } },
      git: { getTree: async args => {
        calls.push({ method: "tree", token, ...args });
        if (options.error) throw options.error;
        return { data: { tree, truncated: options.truncated || false } };
      } },
    }));
    return calls;
  }

  it("mounts a pinned child tree without forwarding parent credentials or exposing .gitmodules", async () => {
    const calls = api([
      { path: ".gitmodules", type: "blob", sha: blob, size: 100 },
      { path: "src", type: "tree", sha: blob },
      { path: "src/Alice.txt", type: "blob", sha: blob, size: 5 },
      { path: "nested", type: "commit", sha },
    ]);
    const files = await expandSubmodules([mount(), { name: ".gitmodules", path: "" }], parent);
    expect(files.map(file => file.name)).to.deep.equal(["dependency", "src", "Alice.txt", "nested"]);
    expect(files[0].submodule).to.equal("included");
    expect(files[2]).to.include({ path: "vendor/dependency/src", sha: blob, size: 5 });
    expect(files[2].upstream).to.deep.equal(upstream);
    expect(files[3].submodule).to.equal("nested");
    expect(calls).to.deep.equal([
      { method: "contents", token: "parent-private-token", owner: "parent", repo: "repo", path: "vendor/dependency", ref: parent.commit },
      { method: "tree", token: "", owner: "child", repo: "public", tree_sha: sha, recursive: "1" },
    ]);
    expect(new FileModel(files[2]).toObject().upstream).to.deep.equal(upstream);
  });

  it("recognizes gitlinks from the parent tree and leaves ordinary repositories at one request", async () => {
    const source = new GitHubStream(parent); let calls = 0;
    source.getGHTree = async () => { calls++; return { tree: [{ path: "README.md", type: "blob", sha: blob, size: 5 }] }; };
    expect((await source.getFiles()).map(file => file.name)).to.deep.equal(["README.md"]); expect(calls).to.equal(1);
    api();
    source.getGHTree = async () => ({ tree: [{ path: "vendor/dependency", type: "commit", mode: "160000", sha }] });
    expect((await source.getFiles())[0].submodule).to.equal("included");
  });

  it("supports relative and SSH GitHub URLs and rejects other hosts and unsafe paths", () => {
    for (const url of ["../public.git", "git@github.com:parent/public.git", "ssh://git@github.com/parent/public.git", "https://github.com/parent/public.git"]) {
      expect(submoduleRepository(url, parent)).to.deep.equal({ organization: "parent", repoName: "public" });
    }
    for (const url of ["https://evil.test/child/repo", "file:///tmp/repo", "https://github.com@evil.test/a/b", "https://github.com/a/b?token=secret", "https://github.com/a%2fb/c"]) expect(submoduleRepository(url, parent)).to.equal(null);
    for (const path of ["../escape", "/absolute", "a/../b", "a\\b", "a//b", "a\0b"]) expect(() => validateMounts([{ ...upstream, path }])).to.throw("invalid_request");
    expect(() => validateMounts([{ ...upstream, path: "lib" }, { ...upstream, path: "lib/nested" }])).to.throw("invalid_request");
  });

  it("leaves private, missing and external children unsupported without blocking parent files", async () => {
    api([], { error: Object.assign(new Error("not found"), { status: 404 }) });
    const result = await expandSubmodules([mount(), { name: "README.md", path: "", size: 3 }], parent);
    expect(result[0].submodule).to.equal("unavailable"); expect(result[1].name).to.equal("README.md");
    const calls = api([], { url: "https://gitlab.com/child/repo.git" });
    expect((await expandSubmodules([mount()], parent))[0].submodule).to.equal("unsupported");
    expect(calls).to.have.length(1);
  });

  it("does not persist transient failures as permanently missing dependencies", async () => {
    const error = Object.assign(new Error("rate limited"), { status: 403 }); api([], { error });
    let caught; try { await expandSubmodules([mount()], parent); } catch (err) { caught = err; }
    expect(caught).to.equal(error);
  });

  it("bounds module count and rejects oversized or truncated child trees", async () => {
    const calls = api();
    const mounts = Array.from({ length: MAX_SUBMODULES + 1 }, (_, i) => ({ ...mount().toObject(), name: `dependency${i}` }));
    const result = await expandSubmodules(mounts, parent);
    expect(result[MAX_SUBMODULES].submodule).to.equal("limit"); expect(calls).to.have.length(MAX_SUBMODULES * 2);
    api(Array.from({ length: MAX_SUBMODULE_ENTRIES + 1 }, (_, i) => ({ path: `file${i}`, type: "blob", sha: blob, size: 1 })));
    expect((await expandSubmodules([mount()], parent))[0].submodule).to.equal("limit");
    api([], { truncated: true }); expect((await expandSubmodules([mount()], parent))[0].submodule).to.equal("limit");
  });

  it("fetches child content anonymously at its upstream path and caches under its parent mount", async () => {
    const source = new GitHubStream({ ...parent, cacheGeneration: "tree:date" }); const cache = new Map(), requests = [];
    stub(storage, "fileInfo", async (_id, path) => { if (!cache.has(path)) throw Object.assign(Error("missing"), { code: "ENOENT" }); return { size: cache.get(path).length }; });
    stub(storage, "write", async (id, path, input) => { expect(id).to.equal(parent.repoId); const chunks = []; for await (const chunk of input) chunks.push(Buffer.from(chunk)); cache.set(path, Buffer.concat(chunks)); });
    stub(storage, "read", async (_id, path) => Readable.from([cache.get(path)]));
    stub(got, "stream", (url, options) => { requests.push({ url, options }); return Readable.from([Buffer.from("Alice")]); });
    for (let i = 0; i < 2; i++) {
      const stream = await source.getFileContentCache("vendor/dependency/src/Alice.txt", parent.repoId, () => ({ sha: blob, size: 5, upstream }));
      for await (const chunk of stream) expect(chunk.toString()).to.equal("Alice");
    }
    expect(requests).to.have.length(1);
    expect(requests[0].url).to.equal(`https://github.com/child/public/raw/${sha}/src/Alice.txt`);
    expect(requests[0].options.headers).to.deep.equal({});
    expect([...cache.keys()][0]).to.match(/\/vendor\/dependency\/src\/Alice\.txt$/);
    const changed = { ...upstream, commit: "d".repeat(40) };
    const stream = await source.getFileContentCache("vendor/dependency/src/Alice.txt", parent.repoId, () => ({ sha: blob, size: 5, upstream: changed }));
    stream.resume(); expect(requests).to.have.length(2);
  });

  it("does not report an unavailable public child as lost parent access", async () => {
    const { isAccessFailure } = require("../src/core/owner-notifications");
    const source = new GitHubStream(parent);
    stub(storage, "fileInfo", async () => { throw Object.assign(Error("missing"), { code: "ENOENT" }); });
    stub(storage, "write", async (_id, _path, input) => { for await (const _chunk of input) { /* consume */ } });
    stub(got, "stream", () => Readable.from((async function* () {
      yield* [];
      throw Object.assign(Error("not found"), { response: { statusCode: 404 } });
    })()));
    let error;
    try { await source.getFileContentCache("vendor/lib/file.txt", parent.repoId, () => ({ sha: blob, size: 5, upstream })); }
    catch (caught) { error = caught; }
    expect(error?.message).to.equal("submodule_not_available");
    expect(isAccessFailure(error)).to.equal(false);
  });

  it("includes pinned child archives with anonymized names and content, omitting manifests and disabled images", async () => {
    const main = await zip({ "parent/README.md": "Alice parent", "parent/.gitmodules": "https://github.com/private/identity" });
    const child = await zip({ "child/src/Alice.txt": "Alice child", "child/.gitmodules": "identity", "child/photo.png": "image" });
    const calls = [];
    stub(got, "stream", (url, options) => { calls.push({ url, options }); return Readable.from([calls.length === 1 ? main : child]); });
    expect(await readZip({ ...zipOptions, contentOptions: { image: false } })).to.deep.equal({
      "README.md": "XXXX-1 parent", "vendor/dependency/src/XXXX-1.txt": "XXXX-1 child",
    });
    expect(calls.map(call => call.url)).to.deep.equal([
      `https://codeload.github.com/parent/repo/zip/${parent.commit}`, `https://codeload.github.com/child/public/zip/${sha}`,
    ]);
    expect(calls.every(call => call.options === undefined)).to.equal(true);
  });

  it("aborts the ZIP if a child exceeds the per-file limit", async () => {
    const main = await zip({ "parent/README.md": "ok" }), child = await zip({ "child/large.txt": "too much data" });
    let calls = 0; stub(got, "stream", () => Readable.from([++calls === 1 ? main : child])); stub(config, "MAX_FILE_SIZE", 4);
    const response = new PassThrough(); response.resume(); const errors = [];
    response.on("error", error => errors.push(error)); const done = new Promise(resolve => response.once("close", resolve));
    await streamAnonymizedZip(zipOptions, response); await done;
    expect(errors.map(error => error.message)).to.deep.equal(["file_too_big"]);
  });
});

describe("submodule transport and public metadata", function () {
  this.timeout(10000);
  it("does not expose upstream repository coordinates in the public tree", async () => {
    const Repository = require("../src/core/Repository").default;
    const files = await Repository.prototype.anonymizedFiles.call({
      _model: { options: { terms: ["Alice"] } },
      files: async () => [{ name: "Alice.txt", path: "vendor/dependency/src", sha: blob, size: 5, upstream, submodule: "included" }],
    }, { includeSha: false });
    expect(files[0]).to.have.all.keys("name", "path", "sha", "size");
    expect(files[0].name).to.equal("XXXX-1.txt");
    expect(JSON.stringify(files)).not.to.include("public");
  });

  for (const mode of ["send", "anonymizedContent"]) {
    it(`preserves child origin through ${mode} and the real streamer route`, async () => {
      const express = require("express");
      const File = require("../src/core/AnonymizedFile").default;
      const { AnonymizeTransformer } = require("../src/core/anonymize-utils");
      const router = require("../src/streamer/route").router;
      const previous = { endpoint: config.STREAMER_ENTRYPOINT, stream: got.stream,
        info: storage.fileInfo, write: storage.write, read: storage.read };
      let server, payload; const cache = new Map(), requests = [];
      try {
        storage.fileInfo = async (_id, path) => { if (!cache.has(path)) throw Object.assign(Error("missing"), { code: "ENOENT" }); return { size: cache.get(path).length }; };
        storage.write = async (_id, path, stream) => { const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); cache.set(path, Buffer.concat(chunks)); };
        storage.read = async (_id, path) => Readable.from([cache.get(path)]);
        got.stream = (url, options) => {
          if (!String(url).startsWith("https://github.com/")) return previous.stream(url, options);
          requests.push({ url, options }); return Readable.from([Buffer.from("Alice")]);
        };
        const app = express(); app.use(express.json());
        app.use((req, _res, next) => { payload = req.body; next(); }); app.use("/api", router);
        server = await new Promise(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
        config.STREAMER_ENTRYPOINT = `http://127.0.0.1:${server.address().port}/`;
        const file = new File({ anonymizedPath: "vendor/dependency/src/XXXX-1.txt", repository: {
          repoId: parent.repoId, options: { terms: ["Alice"] },
          model: { source: { repositoryName: "parent/repo", commit: parent.commit } },
          getToken: parent.getToken, owner: { id: "owner" },
          generateAnonymizeTransformer: filePath => new AnonymizeTransformer({ terms: ["Alice"], filePath, image: true, link: true }),
        } });
        file._file = { name: "Alice.txt", path: "vendor/dependency/src", sha: blob, size: 5, upstream };
        let content = "";
        if (mode === "send") {
          const response = new PassThrough(); response.setHeader = () => {};
          response.on("data", chunk => { content += chunk; });
          await file.send(response);
        } else {
          for await (const chunk of await file.anonymizedContent()) content += chunk;
        }
        expect(content).to.equal("XXXX-1");
        expect(payload.upstream).to.deep.equal(upstream);
        expect(payload.filePath).to.equal("vendor/dependency/src/Alice.txt");
        expect(requests).to.have.length(1);
        expect(requests[0].url).to.equal(`https://github.com/child/public/raw/${sha}/src/Alice.txt`);
        expect(requests[0].options.headers).to.deep.equal({});
      } finally {
        config.STREAMER_ENTRYPOINT = previous.endpoint; got.stream = previous.stream;
        storage.fileInfo = previous.info; storage.write = previous.write; storage.read = previous.read;
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      }
    });
  }

  it("cancels the current child archive when the reader disconnects", async () => {
    const main = await zip({ "parent/README.md": "ok" }); const child = new PassThrough();
    const previous = got.stream; let calls = 0, started;
    const childStarted = new Promise(resolve => { started = resolve; });
    const response = new PassThrough(); response.resume();
    try {
      got.stream = () => { if (++calls === 1) return Readable.from([main]); started(); return child; };
      await streamAnonymizedZip({ ...zipOptions, submodules: [...zipOptions.submodules,
        { ...zipOptions.submodules[0], path: "other/dependency" }] }, response);
      await childStarted; response.destroy();
      await new Promise(resolve => setImmediate(resolve));
      expect(child.destroyed).to.equal(true); expect(calls).to.equal(2);
    } finally { got.stream = previous; child.destroy(); response.destroy(); }
  });
});

describe("legacy submodule manifests", function () {
  it("rejects a cached .gitmodules file even when its public name was anonymized", async () => {
    const File = require("../src/core/AnonymizedFile").default;
    const file = new File({ anonymizedPath: ".XXXX-1", repository: {
      options: { terms: ["gitmodules"] }, model: { source: { type: "GitHubStream" } },
    } });
    file._file = { name: ".gitmodules", path: "", sha: blob, size: 5 };
    for (const read of [() => file.getFileInfo(), () => file.originalPath()]) {
      let error; try { await read(); } catch (caught) { error = caught; }
      expect(error?.message).to.equal("file_not_found");
    }
  });
});
