const { expect } = require("chai");
const express = require("express");
const got = require("got");
const { Readable, PassThrough } = require("stream");
require("ts-node/register/transpile-only");
const config = require("../src/config").default;
const { registerGitHubToken, githubTokenForStreamer } = require("../src/core/github-token-context");
const File = require("../src/core/AnonymizedFile").default;
const GitHubStream = require("../src/core/source/GitHubStream").default;
const { AnonymizeTransformer } = require("../src/core/anonymize-utils");
const streamer = require("../src/streamer/route").default;

async function rejects(promise, message) {
  try { await promise; } catch (error) { expect(error.message).to.equal(message); return; }
  throw new Error("Expected rejection");
}

async function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

describe("public repository streamer handoff", function () {
  it("revalidates public access without exporting handles or owner credentials", async function () {
    let valid = true;
    registerGitHubToken("public-read:transport", {
      quotaKey: "test", publicRepository: "owner/public",
      renew: async () => { if (!valid) throw new Error("revoked"); return "private-owner-token"; },
    });
    expect(await githubTokenForStreamer("public-read:transport", "owner/public")).to.equal("");
    expect(await githubTokenForStreamer("installation-token", "owner/private")).to.equal("installation-token");
    await rejects(githubTokenForStreamer("public-read:transport", "other/repo"), "Public repository access context mismatch");
    valid = false;
    await rejects(githubTokenForStreamer("public-read:transport", "owner/public"), "revoked");
    await rejects(githubTokenForStreamer("public-read:missing", "owner/public"), "Public repository access context expired");
  });

  it("rejects send when the access recheck fails before opening the streamer", async function () {
    const endpoint = config.STREAMER_ENTRYPOINT;
    config.STREAMER_ENTRYPOINT = "http://unused.test/";
    const response = new PassThrough();
    try {
      registerGitHubToken("public-read:revoked-send", {
        quotaKey: "test", publicRepository: "owner/public", renew: async () => { throw new Error("revoked"); },
      });
      const file = new File({ repository: {
        options: { terms: [] }, model: { source: { repositoryName: "owner/public" } },
        getToken: async () => "public-read:revoked-send",
        generateAnonymizeTransformer: filePath => new AnonymizeTransformer({ terms: [], filePath }),
      }, anonymizedPath: "README.md" });
      file._file = { name: "README.md", path: "", sha: "sha", size: 25 };
      await rejects(file.send(response), "revoked");
    } finally {
      config.STREAMER_ENTRYPOINT = endpoint;
      response.destroy();
    }
  });

  for (const [mode, commit] of [
    ["send", "abc"], ["anonymizedContent", "abc"], ["send", undefined], ["send", ""],
  ]) {
    it(`serves a public README through ${mode} with commit ${JSON.stringify(commit)}`, async function () {
      const previous = { endpoint: config.STREAMER_ENTRYPOINT, stream: got.stream, cache: GitHubStream.prototype.getFileContentCache };
      const servers = [];
      let payload;
      const requests = [];
      try {
        registerGitHubToken("public-read:http-test", {
          quotaKey: "test", publicRepository: "owner/public", renew: async () => "private-owner-token",
        });
        got.stream = (url, options) => {
          if (!String(url).startsWith("https://github.com/")) return previous.stream(url, options);
          requests.push({ url, options });
          return Readable.from((async function* () {
            for (const hook of options.hooks.beforeRequest) await hook();
            yield Buffer.from("# README\nAlice wrote this.");
          })());
        };
        GitHubStream.prototype.getFileContentCache = async function (path) {
          return this.downloadWithFallback(await this.data.getToken(), "sha", path);
        };
        const upstream = express();
        upstream.use(express.json());
        upstream.use((req, _res, next) => { payload = req.body; next(); });
        upstream.use("/api", streamer);
        servers.push(await listen(upstream));
        config.STREAMER_ENTRYPOINT = `http://127.0.0.1:${servers[0].address().port}/`;
        const options = { terms: ["Alice"], image: true, link: true };
        const repo = {
          repoId: "test", options,
          model: { source: { repositoryName: "owner/public", commit } },
          getToken: async () => "public-read:http-test",
          generateAnonymizeTransformer: path => new AnonymizeTransformer({ ...options, filePath: path }),
        };
        const file = new File({ repository: repo, anonymizedPath: "README.md" });
        file._file = { name: "README.md", path: "", sha: "sha", size: 25 };
        const api = express();
        api.get("/file", async (_req, res) => {
          try {
            if (mode === "send") await file.send(res);
            else (await file.anonymizedContent()).pipe(res);
          } catch (error) { res.status(500).json({ error: error.message }); }
        });
        servers.push(await listen(api));
        const response = await got(`http://127.0.0.1:${servers[1].address().port}/file`);
        expect(response.body).to.equal("# README\nXXXX-1 wrote this.");
        expect(payload.token).to.equal("");
        expect(JSON.stringify(payload)).not.to.include("public-read:");
        expect(JSON.stringify(payload)).not.to.include("private-owner-token");
        expect(requests).to.have.length(1);
        expect(requests[0].url).to.equal(`https://github.com/owner/public/raw/${commit || "HEAD"}/README.md`);
        expect(requests[0].options.headers).not.to.have.property("authorization");
      } finally {
        got.stream = previous.stream;
        GitHubStream.prototype.getFileContentCache = previous.cache;
        config.STREAMER_ENTRYPOINT = previous.endpoint;
        await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
      }
    });
  }
});
