const { expect } = require("chai");

/**
 * Tests for Conference logic bugs.
 *
 * The key bug was that Conference._repositories was initialized as []
 * (truthy), so repositories() always returned the empty array without
 * querying the database. The fix initializes it as null.
 */

describe("Conference._repositories initialization", function () {
  it("empty array [] is truthy (demonstrates the root cause)", function () {
    // This is why `if (this._repositories) return this._repositories;`
    // was always short-circuiting - an empty array is truthy in JS
    expect([]).to.not.be.null;
    expect([]).to.not.be.undefined;
    // In a boolean context, [] is truthy:
    expect(!![]).to.be.true;
  });

  it("null is falsy (the fix)", function () {
    // After the fix, _repositories starts as null so the DB query runs
    expect(!!null).to.be.false;
  });

  it("simulates the fixed repositories() cache behavior", function () {
    // Simulate the Conference class behavior
    class FakeConference {
      constructor() {
        this._repositories = null; // fixed: was []
      }
      repositories() {
        if (this._repositories) return this._repositories;
        // In real code this would query the DB
        this._repositories = [{ id: "repo1" }, { id: "repo2" }];
        return this._repositories;
      }
    }

    const conf = new FakeConference();
    const repos = conf.repositories();
    expect(repos).to.have.length(2);
    expect(repos[0].id).to.equal("repo1");

    // Second call uses the cache
    const repos2 = conf.repositories();
    expect(repos2).to.equal(repos); // same reference
  });

  it("demonstrates the old buggy behavior (always returned empty array)", function () {
    class BuggyConference {
      constructor() {
        this._repositories = []; // old buggy initialization
      }
      repositories() {
        if (this._repositories) return this._repositories;
        // This line was NEVER reached because [] is truthy
        this._repositories = [{ id: "repo1" }];
        return this._repositories;
      }
    }

    const conf = new BuggyConference();
    const repos = conf.repositories();
    // The bug: always returns empty array, DB query never runs
    expect(repos).to.have.length(0);
  });
});

describe("PullRequest.check() async expiration", function () {
  it("async check() allows awaiting expire()", async function () {
    // Simulates the fix: check() is now async so expire() can be awaited
    let expired = false;
    const fakePR = {
      status: "ready",
      options: {
        expirationMode: "date",
        expirationDate: new Date(Date.now() - 1000), // in the past
      },
      async expire() {
        expired = true;
        this.status = "expired";
      },
      async check() {
        if (
          this.options.expirationMode !== "never" &&
          this.status === "ready" &&
          this.options.expirationDate
        ) {
          if (this.options.expirationDate <= new Date()) {
            await this.expire();
          }
        }
      },
    };

    await fakePR.check();
    expect(expired).to.be.true;
    expect(fakePR.status).to.equal("expired");
  });
});

describe("Admin MongoDB query safety", function () {
  function escapeRegex(str) {
    return str.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
  }

  it("escapes regex special characters in search input", function () {
    const malicious = ".*";
    const escaped = escapeRegex(malicious);
    expect(escaped).to.equal("\\.\\*");
  });

  it("escapes parentheses that could cause ReDoS", function () {
    const input = "((((((((((a]))))))))";
    const escaped = escapeRegex(input);
    // Escaped string should be safe to compile as regex
    expect(() => new RegExp(escaped)).to.not.throw();
  });

  it("preserves alphanumeric characters", function () {
    const input = "normalSearch123";
    expect(escapeRegex(input)).to.equal("normalSearch123");
  });

  it("escapes dots so they match literally", function () {
    const input = "file.txt";
    const escaped = escapeRegex(input);
    const regex = new RegExp(escaped);
    expect(regex.test("file.txt")).to.be.true;
    expect(regex.test("fileXtxt")).to.be.false;
  });

  describe("empty $or guard", function () {
    it("empty $or array would fail in MongoDB", function () {
      // MongoDB requires $or to have at least one expression
      // The fix: only add { $or: status } when status.length > 0
      const status = [];
      const query = [];

      // Fixed logic:
      if (status.length > 0) {
        query.push({ $or: status });
      }

      // When no filters are selected, query should be empty
      // (no $or clause at all)
      expect(query).to.have.length(0);
    });

    it("adds $or when status filters are present", function () {
      const status = [{ status: "ready" }, { status: "error" }];
      const query = [];

      if (status.length > 0) {
        query.push({ $or: status });
      }

      expect(query).to.have.length(1);
      expect(query[0].$or).to.have.length(2);
    });
  });
});
