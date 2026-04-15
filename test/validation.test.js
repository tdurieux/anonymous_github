const { expect } = require("chai");

/**
 * Tests for input validation functions used in repository and pull request
 * creation/update routes.
 *
 * Replicates the pure validation logic from:
 *   - src/server/routes/repository-private.ts  (validateNewRepo)
 *   - src/server/routes/pullRequest-private.ts  (validateNewPullRequest)
 */

// ---------------------------------------------------------------------------
// Replicated validation from repository-private.ts
// ---------------------------------------------------------------------------

function validateNewRepo(repoUpdate) {
  const validCharacters = /^[0-9a-zA-Z\-_]+$/;
  if (
    !repoUpdate.repoId.match(validCharacters) ||
    repoUpdate.repoId.length < 3
  ) {
    throw new Error("invalid_repoId");
  }
  if (!repoUpdate.source.branch) {
    throw new Error("branch_not_specified");
  }
  if (!repoUpdate.source.commit) {
    throw new Error("commit_not_specified");
  }
  if (!repoUpdate.options) {
    throw new Error("options_not_provided");
  }
  if (!Array.isArray(repoUpdate.terms)) {
    throw new Error("invalid_terms_format");
  }
  if (!/^[a-fA-F0-9]+$/.test(repoUpdate.source.commit)) {
    throw new Error("invalid_commit_format");
  }
}

// ---------------------------------------------------------------------------
// Replicated validation from pullRequest-private.ts
// ---------------------------------------------------------------------------

function validateNewPullRequest(pullRequestUpdate) {
  const validCharacters = /^[0-9a-zA-Z\-_]+$/;
  if (
    !pullRequestUpdate.pullRequestId.match(validCharacters) ||
    pullRequestUpdate.pullRequestId.length < 3
  ) {
    throw new Error("invalid_pullRequestId");
  }
  if (!pullRequestUpdate.source.repositoryFullName) {
    throw new Error("repository_not_specified");
  }
  if (!pullRequestUpdate.source.pullRequestId) {
    throw new Error("pullRequestId_not_specified");
  }
  if (
    parseInt(pullRequestUpdate.source.pullRequestId) !=
    pullRequestUpdate.source.pullRequestId
  ) {
    throw new Error("pullRequestId_is_not_a_number");
  }
  if (!pullRequestUpdate.options) {
    throw new Error("options_not_provided");
  }
  if (!Array.isArray(pullRequestUpdate.terms)) {
    throw new Error("invalid_terms_format");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validRepo(overrides = {}) {
  return {
    repoId: "my-test-repo",
    source: { branch: "main", commit: "abc123def" },
    options: { terms: ["secret"] },
    terms: ["secret"],
    ...overrides,
  };
}

function validPR(overrides = {}) {
  return {
    pullRequestId: "my-pr-id",
    source: { repositoryFullName: "owner/repo", pullRequestId: 42 },
    options: { title: true },
    terms: ["author"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: validateNewRepo
// ---------------------------------------------------------------------------

describe("validateNewRepo", function () {
  describe("repoId validation", function () {
    it("accepts valid alphanumeric repoId", function () {
      expect(() => validateNewRepo(validRepo())).to.not.throw();
    });

    it("accepts repoId with hyphens and underscores", function () {
      expect(() =>
        validateNewRepo(validRepo({ repoId: "my-test_repo-123" }))
      ).to.not.throw();
    });

    it("rejects repoId shorter than 3 characters", function () {
      expect(() => validateNewRepo(validRepo({ repoId: "ab" }))).to.throw(
        "invalid_repoId"
      );
    });

    it("accepts repoId of exactly 3 characters", function () {
      expect(() =>
        validateNewRepo(validRepo({ repoId: "abc" }))
      ).to.not.throw();
    });

    it("rejects repoId with spaces", function () {
      expect(() =>
        validateNewRepo(validRepo({ repoId: "my repo" }))
      ).to.throw("invalid_repoId");
    });

    it("rejects repoId with special characters", function () {
      expect(() =>
        validateNewRepo(validRepo({ repoId: "repo@name" }))
      ).to.throw("invalid_repoId");
      expect(() =>
        validateNewRepo(validRepo({ repoId: "repo/name" }))
      ).to.throw("invalid_repoId");
      expect(() =>
        validateNewRepo(validRepo({ repoId: "repo.name" }))
      ).to.throw("invalid_repoId");
    });

    it("rejects empty repoId", function () {
      expect(() => validateNewRepo(validRepo({ repoId: "" }))).to.throw(
        "invalid_repoId"
      );
    });
  });

  describe("source.branch validation", function () {
    it("accepts a valid branch", function () {
      expect(() => validateNewRepo(validRepo())).to.not.throw();
    });

    it("rejects missing branch", function () {
      expect(() =>
        validateNewRepo(
          validRepo({ source: { branch: "", commit: "abc123" } })
        )
      ).to.throw("branch_not_specified");
    });

    it("rejects null branch", function () {
      expect(() =>
        validateNewRepo(
          validRepo({ source: { branch: null, commit: "abc123" } })
        )
      ).to.throw("branch_not_specified");
    });
  });

  describe("source.commit validation", function () {
    it("accepts valid hex commit", function () {
      expect(() => validateNewRepo(validRepo())).to.not.throw();
    });

    it("accepts full 40-character SHA", function () {
      expect(() =>
        validateNewRepo(
          validRepo({
            source: {
              branch: "main",
              commit: "abc123def456789012345678901234567890abcd",
            },
          })
        )
      ).to.not.throw();
    });

    it("accepts uppercase hex", function () {
      expect(() =>
        validateNewRepo(
          validRepo({
            source: { branch: "main", commit: "ABCDEF1234" },
          })
        )
      ).to.not.throw();
    });

    it("rejects missing commit", function () {
      expect(() =>
        validateNewRepo(
          validRepo({ source: { branch: "main", commit: "" } })
        )
      ).to.throw("commit_not_specified");
    });

    it("rejects non-hex commit", function () {
      expect(() =>
        validateNewRepo(
          validRepo({
            source: { branch: "main", commit: "not-a-hex-value" },
          })
        )
      ).to.throw("invalid_commit_format");
    });

    it("rejects commit with spaces", function () {
      expect(() =>
        validateNewRepo(
          validRepo({
            source: { branch: "main", commit: "abc 123" },
          })
        )
      ).to.throw("invalid_commit_format");
    });

    it("rejects commit with g-z letters", function () {
      expect(() =>
        validateNewRepo(
          validRepo({
            source: { branch: "main", commit: "xyz123" },
          })
        )
      ).to.throw("invalid_commit_format");
    });
  });

  describe("options validation", function () {
    it("accepts valid options", function () {
      expect(() => validateNewRepo(validRepo())).to.not.throw();
    });

    it("rejects missing options", function () {
      expect(() =>
        validateNewRepo(validRepo({ options: null }))
      ).to.throw("options_not_provided");
    });

    it("rejects undefined options", function () {
      expect(() =>
        validateNewRepo(validRepo({ options: undefined }))
      ).to.throw("options_not_provided");
    });
  });

  describe("terms validation", function () {
    it("accepts array of terms", function () {
      expect(() => validateNewRepo(validRepo())).to.not.throw();
    });

    it("accepts empty array", function () {
      expect(() =>
        validateNewRepo(validRepo({ terms: [] }))
      ).to.not.throw();
    });

    it("rejects string terms", function () {
      expect(() =>
        validateNewRepo(validRepo({ terms: "not-an-array" }))
      ).to.throw("invalid_terms_format");
    });

    it("rejects null terms", function () {
      expect(() =>
        validateNewRepo(validRepo({ terms: null }))
      ).to.throw("invalid_terms_format");
    });

    it("rejects object terms", function () {
      expect(() =>
        validateNewRepo(validRepo({ terms: { 0: "term" } }))
      ).to.throw("invalid_terms_format");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: validateNewPullRequest
// ---------------------------------------------------------------------------

describe("validateNewPullRequest", function () {
  describe("pullRequestId validation", function () {
    it("accepts valid alphanumeric pullRequestId", function () {
      expect(() => validateNewPullRequest(validPR())).to.not.throw();
    });

    it("accepts pullRequestId with hyphens and underscores", function () {
      expect(() =>
        validateNewPullRequest(validPR({ pullRequestId: "my-pr_123" }))
      ).to.not.throw();
    });

    it("rejects pullRequestId shorter than 3 characters", function () {
      expect(() =>
        validateNewPullRequest(validPR({ pullRequestId: "ab" }))
      ).to.throw("invalid_pullRequestId");
    });

    it("rejects pullRequestId with special characters", function () {
      expect(() =>
        validateNewPullRequest(validPR({ pullRequestId: "pr@name" }))
      ).to.throw("invalid_pullRequestId");
    });
  });

  describe("source.repositoryFullName validation", function () {
    it("accepts valid repository full name", function () {
      expect(() => validateNewPullRequest(validPR())).to.not.throw();
    });

    it("rejects missing repositoryFullName", function () {
      expect(() =>
        validateNewPullRequest(
          validPR({
            source: { repositoryFullName: "", pullRequestId: 42 },
          })
        )
      ).to.throw("repository_not_specified");
    });
  });

  describe("source.pullRequestId validation", function () {
    it("accepts numeric pullRequestId", function () {
      expect(() => validateNewPullRequest(validPR())).to.not.throw();
    });

    it("rejects missing source pullRequestId", function () {
      expect(() =>
        validateNewPullRequest(
          validPR({
            source: {
              repositoryFullName: "owner/repo",
              pullRequestId: 0,
            },
          })
        )
      ).to.throw("pullRequestId_not_specified");
    });

    it("rejects non-numeric string pullRequestId", function () {
      expect(() =>
        validateNewPullRequest(
          validPR({
            source: {
              repositoryFullName: "owner/repo",
              pullRequestId: "abc",
            },
          })
        )
      ).to.throw("pullRequestId_is_not_a_number");
    });

    it("accepts numeric string that parseInt can parse", function () {
      // parseInt("123") == "123" is true due to JS type coercion
      expect(() =>
        validateNewPullRequest(
          validPR({
            source: {
              repositoryFullName: "owner/repo",
              pullRequestId: "123",
            },
          })
        )
      ).to.not.throw();
    });
  });

  describe("options and terms validation", function () {
    it("rejects missing options", function () {
      expect(() =>
        validateNewPullRequest(validPR({ options: null }))
      ).to.throw("options_not_provided");
    });

    it("rejects non-array terms", function () {
      expect(() =>
        validateNewPullRequest(validPR({ terms: "not-array" }))
      ).to.throw("invalid_terms_format");
    });

    it("accepts empty terms array", function () {
      expect(() =>
        validateNewPullRequest(validPR({ terms: [] }))
      ).to.not.throw();
    });
  });
});
