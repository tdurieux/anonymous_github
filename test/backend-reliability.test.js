const { expect } = require("chai");
require("ts-node/register/transpile-only");

const ConferenceModel = require("../src/core/model/conference/conferences.model")
  .default;
const {
  applyConferenceForm,
} = require("../src/server/routes/conference");
const {
  hasRepositorySourceChanged,
} = require("../src/server/routes/repository-private");
const {
  processRemoveRepository,
} = require("../src/queue/processes/removeRepository");
const {
  processRemoveCache,
} = require("../src/queue/processes/removeCache");

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
});
