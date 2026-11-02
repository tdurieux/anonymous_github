require("ts-node/register/transpile-only");

const path = require("path");
const { expect } = require("chai");

const Repository = require("../src/core/Repository").default;
const PullRequest = require("../src/core/PullRequest").default;
const PullRequestModel = require("../src/core/model/anonymizedPullRequests/anonymizedPullRequests.model").default;
const github = require("../src/core/GitHubUtils");
const githubApp = require("../src/core/github-app");
const routeUtils = require("../src/server/routes/route-utils");
const GitHubStream = require("../src/core/source/GitHubStream").default;
const {
  RepositoryStatus,
} = require("../src/core/types");
const { joinUrl } = require("../src/core/url-utils");
const pullRequestRouter = require("../src/server/routes/pullRequest-private").default;
const {
  resolveWorkerProcessorPath,
} = require("../src/queue/worker-path");

describe("Runtime regression fixes", function () {
  const restores = [];
  function stub(object, key, value) {
    const original = object[key];
    restores.push(() => { object[key] = original; });
    object[key] = value;
  }
  afterEach(() => { while (restores.length) restores.pop()(); });

  describe("joinUrl", function () {
    it("preserves the double slash in https URLs", function () {
      expect(joinUrl("https://streamer.example.com", "api/download")).to.equal(
        "https://streamer.example.com/api/download"
      );
    });

    it("handles base URLs that already end with a slash", function () {
      expect(joinUrl("http://localhost:3000/", "/api")).to.equal(
        "http://localhost:3000/api"
      );
    });
  });

  describe("PullRequest.download()", function () {
    it("uses the authenticated GitHub API diff endpoint", async function () {
      const pullRequest = new PullRequest(new PullRequestModel({
        source: { repositoryFullName: "owner/repo", pullRequestId: 42 },
      }));
      pullRequest.getToken = async () => "secret-token";
      const requests = [];
      const tokens = [];
      stub(github, "octokit", token => {
        tokens.push(token);
        return {
          rest: { pulls: { get: async options => {
            requests.push(options);
            return { data: options.mediaType?.format === "diff" ? "private diff" : {
              title: "Private PR", base: { repo: { full_name: "owner/repo" } }, head: {},
            } };
          } } },
          paginate: async () => [],
        };
      });

      await pullRequest.download();

      expect(tokens).to.deep.equal(["secret-token"]);
      expect(requests).to.deep.equal([
        { owner: "owner", repo: "repo", pull_number: 42 },
        { owner: "owner", repo: "repo", pull_number: 42, mediaType: { format: "diff" } },
      ]);
      expect(pullRequest.model.pullRequest.diff).to.equal("private diff");
    });
  });

  describe("POST / pull request creation", function () {
    it("stores the conference on the persisted model", async function () {
      const update = {
        pullRequestId: "anon-pr-1",
        conference: "conf-2026",
        source: {
          repositoryFullName: "owner/repo",
          pullRequestId: 123,
        },
        options: {
          expirationMode: "never",
        },
        terms: [],
      };
      const user = {
        id: "507f191e810c19729de860ea",
      };
      const saved = [];
      let response;
      let anonymized = false;
      stub(routeUtils, "getUser", async () => user);
      stub(routeUtils, "handleError", error => { throw error; });
      stub(githubApp, "selectRepositoryAccess", async () => ({ binding: { kind: "oauth" } }));
      stub(PullRequestModel.prototype, "save", async function () {
        saved.push(this.toObject());
        return this;
      });
      stub(PullRequest.prototype, "anonymize", async function () {
        expect(saved).to.have.length(1);
        anonymized = true;
      });
      const route = pullRequestRouter.stack.find(layer =>
        layer.route?.path === "/" && layer.route.methods.post).route;

      await route.stack[0].handle({ body: update }, { send: value => { response = value; } });

      expect(saved).to.have.length(1);
      expect(saved[0].conference).to.equal("conf-2026");
      expect(saved[0].source.repositoryFullName).to.equal("owner/repo");
      expect(saved[0].source.pullRequestId).to.equal(123);
      expect(response.conference).to.equal("conf-2026");
      expect(anonymized).to.equal(true);
    });
  });

  describe("Repository.check()", function () {
    it("records logical expiration before throwing repository_expired", async function () {
      const repo = new Repository({
        owner: "507f191e810c19729de860ea",
        options: {
          expirationMode: "date",
          expirationDate: new Date(Date.now() - 1000),
        },
        status: RepositoryStatus.READY,
        statusDate: new Date(),
        source: {
          repositoryName: "owner/repo",
          type: "GitHubStream",
        },
      });

      let expired = false;
      repo.markExpired = async function () {
        await Promise.resolve();
        expired = true;
        this.model.status = RepositoryStatus.EXPIRED;
      };

      try {
        await repo.check();
        throw new Error("expected Repository.check() to throw");
      } catch (error) {
        expect(error.message).to.equal("repository_expired");
      }

      expect(expired).to.equal(true);
    });
  });

  describe("GitHubStream.getTruncatedTree()", function () {
    it("recursively refetches truncated subtrees", async function () {
      const source = new GitHubStream({
        repoId: "repo-1",
        organization: "owner",
        repoName: "repo",
        commit: "head",
        getToken: async () => "token",
      });

      const calls = [];
      source.tree2Tree = function (tree, parentPath = "") {
        return tree.map((entry) =>
          path.posix.join(parentPath, entry.path || "")
        );
      };
      source.getGHTree = async function (_oct, _token, sha, _count, opt) {
        calls.push({ sha, recursive: opt.recursive === true });
        if (sha === "head" && opt.recursive) return { tree: [], truncated: true };
        if (sha === "head") {
          return {
            tree: [{ type: "tree", path: "src", sha: "src-sha" }],
            truncated: false,
          };
        }
        if (sha === "src-sha" && opt.recursive === true) {
          return {
            tree: [],
            truncated: true,
          };
        }
        if (sha === "src-sha" && opt.recursive === false) {
          return {
            tree: [{ type: "tree", path: "deep", sha: "deep-sha" }],
            truncated: false,
          };
        }
        if (sha === "deep-sha" && opt.recursive === true) {
          return {
            tree: [{ type: "blob", path: "file.ts", sha: "file-sha" }],
            truncated: false,
          };
        }
        throw new Error(`unexpected request: ${sha}:${opt.recursive}`);
      };

      const files = await source.getTruncatedTree("head");

      expect(files).to.deep.equal(["src", "src/deep", "src/deep/file.ts"]);
      expect(calls).to.deep.equal([
        { sha: "head", recursive: true },
        { sha: "head", recursive: false },
        { sha: "src-sha", recursive: true },
        { sha: "src-sha", recursive: false },
        { sha: "deep-sha", recursive: true },
      ]);
    });
  });

  describe("resolveWorkerProcessorPath", function () {
    it("falls back to the source-mode worker wrapper when build output is missing", function () {
      const resolved = resolveWorkerProcessorPath(
        "downloadRepository",
        () => false
      );

      expect(resolved).to.equal(
        path.resolve("src/queue/processes/downloadRepository.worker.js")
      );
    });

    it("prefers the built worker script when it exists", function () {
      const resolved = resolveWorkerProcessorPath("removeCache", (candidate) =>
        candidate.endsWith(path.join("build", "queue", "processes", "removeCache.js"))
      );

      expect(resolved).to.equal(
        path.resolve("build/queue/processes/removeCache.js")
      );
    });
  });
});
