const { expect } = require("chai");
const { join } = require("path");

/**
 * Tests for database input validation guards and Storage.repoPath(),
 * plus the extractZip decodeString path-stripping logic.
 *
 * The database functions (getRepository, getPullRequest) validate their
 * input before querying MongoDB. We replicate those guards here.
 * Storage.repoPath() is a pure function we can test directly.
 */

// ---------------------------------------------------------------------------
// Replicated database input validation
// ---------------------------------------------------------------------------

function validateRepoId(repoId) {
  if (!repoId || repoId == "undefined") {
    throw new Error("repo_not_found");
  }
}

function validatePullRequestId(pullRequestId) {
  if (!pullRequestId || pullRequestId == "undefined") {
    throw new Error("pull_request_not_found");
  }
}

// ---------------------------------------------------------------------------
// Replicated Storage.repoPath() from src/core/storage/Storage.ts
// ---------------------------------------------------------------------------

function repoPath(repoId) {
  return join(repoId, "original") + "/";
}

// ---------------------------------------------------------------------------
// Replicated extractZip decodeString from FileSystem.ts
// ---------------------------------------------------------------------------

function decodeZipEntryName(name) {
  const newName = name.substr(name.indexOf("/") + 1);
  if (newName == "") {
    return "___IGNORE___";
  }
  return newName;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Database input validation", function () {
  describe("getRepository guard", function () {
    it("rejects null repoId", function () {
      expect(() => validateRepoId(null)).to.throw("repo_not_found");
    });

    it("rejects undefined repoId", function () {
      expect(() => validateRepoId(undefined)).to.throw("repo_not_found");
    });

    it('rejects the string "undefined"', function () {
      expect(() => validateRepoId("undefined")).to.throw("repo_not_found");
    });

    it("rejects empty string", function () {
      expect(() => validateRepoId("")).to.throw("repo_not_found");
    });

    it("accepts a valid repoId string", function () {
      expect(() => validateRepoId("my-repo-123")).to.not.throw();
    });

    it("accepts a numeric-looking repoId", function () {
      expect(() => validateRepoId("12345")).to.not.throw();
    });
  });

  describe("getPullRequest guard", function () {
    it("rejects null pullRequestId", function () {
      expect(() => validatePullRequestId(null)).to.throw(
        "pull_request_not_found"
      );
    });

    it("rejects undefined pullRequestId", function () {
      expect(() => validatePullRequestId(undefined)).to.throw(
        "pull_request_not_found"
      );
    });

    it('rejects the string "undefined"', function () {
      expect(() => validatePullRequestId("undefined")).to.throw(
        "pull_request_not_found"
      );
    });

    it("rejects empty string", function () {
      expect(() => validatePullRequestId("")).to.throw(
        "pull_request_not_found"
      );
    });

    it("accepts a valid pullRequestId string", function () {
      expect(() => validatePullRequestId("my-pr-42")).to.not.throw();
    });
  });
});

describe("Storage.repoPath()", function () {
  it("returns {repoId}/original/ for a simple repoId", function () {
    expect(repoPath("abc123")).to.equal("abc123/original/");
  });

  it("joins with path separator", function () {
    const result = repoPath("my-repo");
    expect(result).to.equal("my-repo/original/");
  });

  it("handles repoId with hyphens", function () {
    expect(repoPath("my-anon-repo")).to.equal("my-anon-repo/original/");
  });

  it("handles repoId with underscores", function () {
    expect(repoPath("repo_123")).to.equal("repo_123/original/");
  });

  it("always ends with a forward slash", function () {
    expect(repoPath("test").endsWith("/")).to.be.true;
  });

  it("always includes 'original' subdirectory", function () {
    expect(repoPath("any-repo")).to.include("/original");
  });
});

describe("extractZip decodeString (path stripping)", function () {
  it("strips the root folder prefix from zip entries", function () {
    // GitHub zip archives have a root folder like "owner-repo-commitsha/"
    expect(decodeZipEntryName("owner-repo-abc123/src/file.ts")).to.equal(
      "src/file.ts"
    );
  });

  it("strips only the first path component", function () {
    expect(decodeZipEntryName("root/a/b/c.txt")).to.equal("a/b/c.txt");
  });

  it('returns ___IGNORE___ for root directory entry (trailing /)', function () {
    // Root folder entry is like "owner-repo-abc123/"
    // After substr(indexOf("/")+1), the result is ""
    expect(decodeZipEntryName("owner-repo-abc123/")).to.equal("___IGNORE___");
  });

  it("handles files directly under root", function () {
    expect(decodeZipEntryName("root/README.md")).to.equal("README.md");
  });

  it("handles deeply nested paths", function () {
    expect(decodeZipEntryName("root/a/b/c/d/e/f.txt")).to.equal(
      "a/b/c/d/e/f.txt"
    );
  });

  it("handles entry with no slash (file at root level)", function () {
    // If there's no "/", indexOf returns -1, substr(0) returns the whole string
    expect(decodeZipEntryName("justfile.txt")).to.equal("justfile.txt");
  });

  it("handles entry that is just a slash", function () {
    expect(decodeZipEntryName("/")).to.equal("___IGNORE___");
  });

  it("preserves the rest of the path structure", function () {
    const result = decodeZipEntryName("prefix/src/components/App.tsx");
    expect(result).to.equal("src/components/App.tsx");
  });
});
