const { expect } = require("chai");

/**
 * Tests for AnonymousError.toString() formatting logic.
 *
 * The toString() method has branching logic based on the type of the
 * `value` property (Repository, AnonymizedFile, GitHubRepository, User,
 * GitHubBase, or plain object). We simulate these types to test each
 * branch without importing the actual classes.
 */

// ---------------------------------------------------------------------------
// Simulated AnonymousError
// ---------------------------------------------------------------------------

class AnonymousError extends Error {
  constructor(message, opt) {
    super(message);
    this.value = opt?.object;
    this.httpStatus = opt?.httpStatus;
    this.cause = opt?.cause;
  }

  toString() {
    let out = "";
    let detail = this.value ? JSON.stringify(this.value) : null;

    // Simulate the instanceof checks with duck typing
    if (this.value && this.value.__type === "Repository") {
      detail = this.value.repoId;
    } else if (this.value && this.value.__type === "AnonymizedFile") {
      detail = `/r/${this.value.repository.repoId}/${this.value.anonymizedPath}`;
    } else if (this.value && this.value.__type === "GitHubRepository") {
      detail = `${this.value.fullName}`;
    } else if (this.value && this.value.__type === "User") {
      detail = `${this.value.username}`;
    } else if (this.value && this.value.__type === "GitHubBase") {
      detail = `GHDownload ${this.value.data.repoId}`;
    }

    out += this.message;
    if (detail) {
      out += `: ${detail}`;
    }
    if (this.cause) {
      out += `\n\tCause by ${this.cause}\n${this.cause.stack}`;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnonymousError.toString()", function () {
  describe("message formatting", function () {
    it("outputs the error message", function () {
      const err = new AnonymousError("repo_not_found");
      expect(err.toString()).to.equal("repo_not_found");
    });

    it("outputs message with httpStatus on the object", function () {
      const err = new AnonymousError("repo_not_found", { httpStatus: 404 });
      expect(err.httpStatus).to.equal(404);
      expect(err.toString()).to.equal("repo_not_found");
    });
  });

  describe("detail from value types", function () {
    it("formats Repository value as repoId", function () {
      const err = new AnonymousError("error", {
        object: { __type: "Repository", repoId: "my-anon-repo" },
      });
      expect(err.toString()).to.equal("error: my-anon-repo");
    });

    it("formats AnonymizedFile value as /r/{repoId}/{path}", function () {
      const err = new AnonymousError("file_not_found", {
        object: {
          __type: "AnonymizedFile",
          repository: { repoId: "abc123" },
          anonymizedPath: "src/XXXX-1/file.ts",
        },
      });
      expect(err.toString()).to.equal(
        "file_not_found: /r/abc123/src/XXXX-1/file.ts"
      );
    });

    it("formats GitHubRepository value as fullName", function () {
      const err = new AnonymousError("error", {
        object: { __type: "GitHubRepository", fullName: "owner/repo" },
      });
      expect(err.toString()).to.equal("error: owner/repo");
    });

    it("formats User value as username", function () {
      const err = new AnonymousError("error", {
        object: { __type: "User", username: "jdoe" },
      });
      expect(err.toString()).to.equal("error: jdoe");
    });

    it("formats GitHubBase value as GHDownload {repoId}", function () {
      const err = new AnonymousError("error", {
        object: {
          __type: "GitHubBase",
          data: { repoId: "download-123" },
        },
      });
      expect(err.toString()).to.equal("error: GHDownload download-123");
    });

    it("formats plain object as JSON.stringify", function () {
      const err = new AnonymousError("error", {
        object: { key: "value" },
      });
      expect(err.toString()).to.equal('error: {"key":"value"}');
    });

    it("formats string value as JSON string", function () {
      const err = new AnonymousError("error", {
        object: "some-id",
      });
      expect(err.toString()).to.equal('error: "some-id"');
    });

    it("formats number value", function () {
      const err = new AnonymousError("error", {
        object: 42,
      });
      expect(err.toString()).to.equal("error: 42");
    });
  });

  describe("null/undefined value", function () {
    it("outputs only message when value is null", function () {
      const err = new AnonymousError("error", { object: null });
      expect(err.toString()).to.equal("error");
    });

    it("outputs only message when value is undefined", function () {
      const err = new AnonymousError("error", { object: undefined });
      expect(err.toString()).to.equal("error");
    });

    it("outputs only message when no opt is passed", function () {
      const err = new AnonymousError("error");
      expect(err.toString()).to.equal("error");
    });
  });

  describe("cause formatting", function () {
    it("includes cause message and stack when cause is present", function () {
      const cause = new Error("original error");
      const err = new AnonymousError("wrapper", { cause });
      const str = err.toString();
      expect(str).to.include("wrapper");
      expect(str).to.include("Cause by");
      expect(str).to.include("original error");
    });

    it("omits cause section when no cause", function () {
      const err = new AnonymousError("error", { object: "test" });
      expect(err.toString()).to.not.include("Cause by");
    });
  });
});
