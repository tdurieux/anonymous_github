const { expect } = require("chai");
require("ts-node/register/transpile-only");

const ConferenceModel = require("../src/core/model/conference/conferences.model")
  .default;
const {
  applyConferenceForm,
} = require("../src/server/routes/conference");
const {
  hasRepositorySourceChanged,
  shouldReactivateInactiveRepository,
} = require("../src/server/routes/repository-private");
const {
  processRemoveRepository,
  createRemoveRepositoryProcessor,
} = require("../src/queue/processes/removeRepository");
const {
  processRemoveCache,
  createRemoveCacheProcessor,
} = require("../src/queue/processes/removeCache");
const { addRemovalJob } = require("../src/queue");
const {
  repositoryMaintenanceQuery,
} = require("../src/server/schedule");
const Repository = require("../src/core/Repository").default;
const AnonymizedRepositoryModel = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const queueModule = require("../src/queue");
const routeUtils = require("../src/server/routes/route-utils");

const UserModel = require("../src/core/model/users/users.model").default;

describe("removal recovery", function () {
  let originals;
  beforeEach(function () {
    originals = {
      distinct: UserModel.distinct,
      queue: queueModule.removeQueue,
      find: AnonymizedRepositoryModel.find,
      findOneAndUpdate: AnonymizedRepositoryModel.findOneAndUpdate,
      getRepo: routeUtils.getRepo,
      getUser: routeUtils.getUser,
      handleError: routeUtils.handleError,
    };
    UserModel.distinct = () => ({ exec: async () => [] });
  });
  afterEach(function () {
    UserModel.distinct = originals.distinct;
    queueModule.removeQueue = originals.queue;
    AnonymizedRepositoryModel.find = originals.find;
    AnonymizedRepositoryModel.findOneAndUpdate = originals.findOneAndUpdate;
    routeUtils.getRepo = originals.getRepo;
    routeUtils.getUser = originals.getUser;
    routeUtils.handleError = originals.handleError;
  });

  for (const status of ["ready", "preparing", "removed", "error"]) {
    it(`discards an old failed removal after restoration to ${status}`, async function () {
      let discarded = false;
      let queued = false;
      const job = {
        data: { repoId: "repo-1" }, timestamp: 1000,
        remove: async () => { discarded = true; },
      };
      queueModule.removeQueue = {
        getJobs: async () => [job],
        getJob: async () => undefined,
        add: async () => { queued = true; },
      };
      AnonymizedRepositoryModel.findOneAndUpdate = (filter) => ({
        collation() { return this; },
        exec: async () => {
          // A restored snapshot was created after the failed deletion request.
          const eligible = require("sift").default(filter)({
            repoId: "repo-1", status, anonymizeDate: new Date(2000),
          });
          return eligible ? { repoId: "repo-1" } : null;
        },
      });
      AnonymizedRepositoryModel.find = () => ({ lean: async () => [] });
      await queueModule.recoverStuckRemoving();
      expect(discarded).to.equal(true);
      expect(queued).to.equal(false);
    });
  }

  for (const status of ["error", "removing"]) {
    it(`retries a failed removal still in ${status}`, async function () {
      const repo = {
        repoId: "repo-1", status, anonymizeDate: new Date(500),
        statusDate: new Date(3000),
      };
      let added;
      const job = { data: { repoId: repo.repoId }, timestamp: 1000, finishedOn: 2000 };
      queueModule.removeQueue = {
        getJobs: async () => [job],
        getJob: async () => undefined,
        add: async (...args) => { added = args; },
      };
      AnonymizedRepositoryModel.findOneAndUpdate = (filter, update) => ({
        collation() { return this; },
        exec: async () => {
          if (!require("sift").default(filter)(repo)) return null;
          Object.assign(repo, update.$set);
          return repo;
        },
      });
      AnonymizedRepositoryModel.find = () => ({ lean: async () => [] });
      await queueModule.recoverStuckRemoving();
      expect(repo.status).to.equal("removing");
      expect(added[1]).to.deep.equal({ repoId: repo.repoId });
    });
  }

  it("preserves deletion across a failed request enqueue and recovery enqueue", async function () {
    const repo = new Repository(new AnonymizedRepositoryModel({
      repoId: "repo-1", status: "ready",
      owner: "507f1f77bcf86cd799439011",
      options: { expirationMode: "never" }, source: {},
    }));
    routeUtils.getRepo = async () => repo;
    routeUtils.getUser = async () => ({ model: { id: "admin" }, isAdmin: true });
    let responseError;
    routeUtils.handleError = (error) => { responseError = error; };
    const failure = new Error("Redis unavailable");
    queueModule.removeQueue = {
      getJobs: async () => [],
      getJob: async () => undefined,
      add: async () => { throw failure; },
    };
    const router = require("../src/server/routes/repository-private").default;
    const handler = router.stack.find((layer) =>
      layer.route?.path === "/:repoId/" && layer.route.methods.delete
    ).route.stack[0].handle;
    await handler({ params: { repoId: repo.repoId } }, {});
    expect(responseError).to.equal(failure);
    expect(repo.status).to.equal("removing");
    let publicError;
    try { await repo.check(); } catch (error) { publicError = error; }
    expect(publicError.message).to.equal("repository_expired");

    AnonymizedRepositoryModel.find = (filter) => ({
      lean: async () => repo.status === filter.status ? [repo.model] : [],
    });
    await queueModule.recoverStuckRemoving();
    expect(repo.status).to.equal("removing");
    let added;
    queueModule.removeQueue.add = async (...args) => { added = args; };
    await queueModule.recoverStuckRemoving();
    expect(added[1]).to.deep.equal({ repoId: repo.repoId });
  });
});

describe("conference edits", function () {
  const form = {
    name: "Updated",
    startDate: "2026-01-01",
    endDate: "2026-02-01",
    url: "https://example.test",
    options: { expirationMode: "never" },
  };

  it("preserves existing repository membership", function () {
    const existing = [{ id: "507f1f77bcf86cd799439011", addDate: new Date() }];
    const model = new ConferenceModel({ repositories: existing });
    applyConferenceForm(model, form, false);
    expect(model.repositories).to.have.length(1);
    expect(model.repositories[0].id.toString()).to.equal(existing[0].id);
  });

  it("initializes repository membership for a new conference", function () {
    const model = new ConferenceModel();
    applyConferenceForm(model, form, true);
    expect(model.repositories).to.deep.equal([]);
  });
});

describe("repository update source detection", function () {
  const model = {
    source: {
      commit: "abc123",
      branch: "main",
      repositoryName: "owner/repo",
    },
  };

  it("does not redownload for an option-only edit", function () {
    expect(
      hasRepositorySourceChanged(model, {
        fullName: "owner/repo",
        source: { commit: "abc123", branch: "main" },
        options: { image: false },
      })
    ).to.equal(false);
  });

  it("redownloads when the commit, branch, or repository changes", function () {
    expect(
      hasRepositorySourceChanged(model, {
        fullName: "owner/repo",
        source: { commit: "def456", branch: "main" },
      })
    ).to.equal(true);
    expect(
      hasRepositorySourceChanged(model, {
        fullName: "owner/repo",
        source: { commit: "abc123", branch: "next" },
      })
    ).to.equal(true);
    expect(
      hasRepositorySourceChanged(model, {
        fullName: "other/repo",
        source: { commit: "abc123", branch: "main" },
      })
    ).to.equal(true);
  });

  it("rebuilds an expired repository when its expiration is in the future", function () {
    const now = new Date("2026-08-20T00:00:00.000Z");
    expect(
      shouldReactivateInactiveRepository(
        {
          status: "expired",
          options: {
            expirationMode: "redirect",
            expirationDate: new Date("2027-05-01T03:57:53.395Z"),
          },
        },
        now
      )
    ).to.equal(true);
  });

  it("does not rebuild an expired repository with a stale expiration", function () {
    const now = new Date("2026-08-20T00:00:00.000Z");
    expect(
      shouldReactivateInactiveRepository(
        {
          status: "expired",
          options: {
            expirationMode: "redirect",
            expirationDate: new Date("2026-01-01T00:00:00.000Z"),
          },
        },
        now
      )
    ).to.equal(false);
  });

  it("rebuilds an expired repository configured never to expire", function () {
    expect(
      shouldReactivateInactiveRepository({
        status: "expired",
        options: { expirationMode: "never" },
      })
    ).to.equal(true);
  });

  it("rebuilds a removed repository when its expiration is in the future", function () {
    const now = new Date("2026-08-20T00:00:00.000Z");
    expect(
      shouldReactivateInactiveRepository(
        {
          status: "removed",
          options: {
            expirationMode: "remove",
            expirationDate: new Date("2027-01-31T04:18:02.444Z"),
          },
        },
        now
      )
    ).to.equal(true);
  });
});

describe("removal workers", function () {
  const job = { data: { repoId: "repo-1" } };

  it("rejects the repository job after recording a removal error", async function () {
    const statuses = [];
    const failure = new Error("storage unavailable");
    const repo = {
      updateStatus: async (status, message) => statuses.push([status, message]),
      remove: async () => {
        throw failure;
      },
    };

    let caught;
    try {
      await processRemoveRepository(job, {
        connect: async () => undefined,
        getRepository: async () => repo,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.equal(failure);
    expect(statuses[statuses.length - 1][1]).to.equal(failure.message);
  });

  it("records errors that happen before repository removal starts", async function () {
    const statuses = [];
    const failure = new Error("status write failed");
    let statusCalls = 0;
    const repo = {
      updateStatus: async (status, message) => {
        statusCalls++;
        statuses.push([status, message]);
        if (statusCalls === 1) throw failure;
      },
      remove: async () => undefined,
    };

    let caught;
    try {
      await processRemoveRepository(job, {
        connect: async () => undefined,
        getRepository: async () => repo,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.equal(failure);
    expect(statuses[statuses.length - 1][1]).to.equal(failure.message);
  });

  it("does not treat the BullMQ lock token as a database dependency", async function () {
    const statuses = [];
    const database = {
      connect: async () => undefined,
      getRepository: async () => ({
        updateStatus: async (status) => statuses.push(status),
        remove: async () => undefined,
      }),
    };
    const processor = createRemoveRepositoryProcessor(database);

    await processor(job, "bullmq-lock-token");

    expect(statuses).to.include("removing");
  });

  it("does not add a duplicate when a removal job is live", async function () {
    let additions = 0;
    const queue = {
      getJob: async () => ({
        getState: async () => "active",
        remove: async () => undefined,
      }),
      add: async () => {
        additions++;
      },
    };

    expect(await addRemovalJob("repo-1", queue)).to.equal(false);
    expect(additions).to.equal(0);
  });

  it("replaces a terminal removal job with a retryable job", async function () {
    let removed = false;
    let added;
    const queue = {
      getJob: async () => ({
        getState: async () => "failed",
        remove: async () => {
          removed = true;
        },
      }),
      add: async (...args) => {
        added = args;
      },
    };

    expect(await addRemovalJob("repo-1", queue)).to.equal(true);
    expect(removed).to.equal(true);
    expect(added[0]).to.equal("repo-1");
    expect(added[1]).to.deep.equal({ repoId: "repo-1" });
    expect(added[2].jobId).to.equal("repo-repo-1");
    expect(added[2].attempts).to.equal(3);
    expect(added[2].removeOnFail).to.deep.equal({ count: 1000 });
  });

  it("rejects cache jobs when cache removal fails", async function () {
    const failure = new Error("storage unavailable");
    let caught;
    try {
      await processRemoveCache(job, {
        connect: async () => undefined,
        getRepository: async () => ({
          removeCache: async () => {
            throw failure;
          },
        }),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.equal(failure);
  });

  it("keeps the BullMQ lock token out of cache worker injection", async function () {
    let removed = false;
    const processor = createRemoveCacheProcessor({
      connect: async () => undefined,
      getRepository: async () => ({
        removeCache: async () => {
          removed = true;
        },
      }),
    });

    await processor(job, "bullmq-lock-token");

    expect(removed).to.equal(true);
  });
});

describe("repository expiration maintenance", function () {
  it("selects due repositories regardless of their cache reset flag", function () {
    const now = new Date("2026-08-20T00:00:00.000Z");
    const query = repositoryMaintenanceQuery(now);

    expect(query).not.to.have.property("isReseted");
    expect(query.$or[0]).to.deep.equal({
      "options.expirationMode": { $in: ["redirect", "remove"] },
      "options.expirationDate": { $lte: now },
    });
  });

  it("marks a cache as present again after content is restored", async function () {
    const model = new AnonymizedRepositoryModel({
      repoId: "repo-cache-state",
      owner: "507f1f77bcf86cd799439011",
      isReseted: true,
      status: "ready",
      options: { terms: [], expirationMode: "never" },
      source: { type: "GitHubStream", repositoryName: "owner/repo" },
    });
    const repo = new Repository(model);

    await repo.markCachePresent();

    expect(repo.model.isReseted).to.equal(false);
  });
});
