const { expect } = require("chai");

/**
 * Tests for PullRequest.content() option-based filtering logic.
 *
 * The content() method selectively includes fields in the output based on
 * which options (title, body, comments, username, date, diff, origin) are
 * enabled. We replicate this logic with a simplified anonymizer to test
 * the filtering in isolation.
 */

// ---------------------------------------------------------------------------
// Simplified anonymizer (mirrors ContentAnonimizer)
// ---------------------------------------------------------------------------

function makeAnonymizer(terms) {
  return {
    anonymize(content) {
      let result = content;
      (terms || []).forEach((term, i) => {
        if (term.trim() === "") return;
        const mask = "XXXX-" + (i + 1);
        result = result.replace(new RegExp(`\\b${term}\\b`, "gi"), mask);
      });
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Replicated PullRequest.content() logic
// ---------------------------------------------------------------------------

function buildPRContent(pullRequest, options, terms) {
  const anonymizer = makeAnonymizer(terms);
  const output = {
    anonymizeDate: pullRequest.anonymizeDate,
    merged: pullRequest.merged,
    mergedDate: pullRequest.mergedDate,
    state: pullRequest.state,
    draft: pullRequest.draft,
  };

  if (options.title) {
    output.title = anonymizer.anonymize(pullRequest.title);
  }
  if (options.body) {
    output.body = anonymizer.anonymize(pullRequest.body);
  }
  if (options.comments) {
    output.comments = (pullRequest.comments || []).map((comment) => {
      const o = {};
      if (options.body) o.body = anonymizer.anonymize(comment.body);
      if (options.username) o.author = anonymizer.anonymize(comment.author);
      if (options.date) {
        o.updatedDate = comment.updatedDate;
        o.creationDate = comment.creationDate;
      }
      return o;
    });
  }
  if (options.diff) {
    output.diff = anonymizer.anonymize(pullRequest.diff);
  }
  if (options.origin) {
    output.baseRepositoryFullName = pullRequest.baseRepositoryFullName;
  }
  if (options.date) {
    output.updatedDate = pullRequest.updatedDate;
    output.creationDate = pullRequest.creationDate;
  }
  return output;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const samplePR = {
  anonymizeDate: new Date("2024-01-15"),
  merged: true,
  mergedDate: new Date("2024-01-14"),
  state: "closed",
  draft: false,
  title: "Fix bug in AuthorModule by Alice",
  body: "Alice fixed the AuthorModule which was broken.",
  diff: "--- a/AuthorModule.ts\n+++ b/AuthorModule.ts\n-broken code by Alice",
  baseRepositoryFullName: "alice/project",
  updatedDate: new Date("2024-01-14"),
  creationDate: new Date("2024-01-10"),
  comments: [
    {
      body: "Good fix, Alice!",
      author: "Alice",
      updatedDate: new Date("2024-01-12"),
      creationDate: new Date("2024-01-11"),
    },
    {
      body: "LGTM",
      author: "Bob",
      updatedDate: new Date("2024-01-13"),
      creationDate: new Date("2024-01-13"),
    },
  ],
};

const terms = ["Alice", "AuthorModule"];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PullRequest.content()", function () {
  describe("always-included fields", function () {
    it("always includes merged, mergedDate, state, draft", function () {
      const result = buildPRContent(samplePR, {}, []);
      expect(result.merged).to.be.true;
      expect(result.mergedDate).to.deep.equal(new Date("2024-01-14"));
      expect(result.state).to.equal("closed");
      expect(result.draft).to.be.false;
      expect(result.anonymizeDate).to.deep.equal(new Date("2024-01-15"));
    });
  });

  describe("title option", function () {
    it("includes anonymized title when enabled", function () {
      const result = buildPRContent(samplePR, { title: true }, terms);
      expect(result.title).to.exist;
      expect(result.title).to.not.include("Alice");
      expect(result.title).to.not.include("AuthorModule");
      expect(result.title).to.include("XXXX-1");
      expect(result.title).to.include("XXXX-2");
    });

    it("omits title when disabled", function () {
      const result = buildPRContent(samplePR, { title: false }, terms);
      expect(result.title).to.be.undefined;
    });
  });

  describe("body option", function () {
    it("includes anonymized body when enabled", function () {
      const result = buildPRContent(samplePR, { body: true }, terms);
      expect(result.body).to.exist;
      expect(result.body).to.not.include("Alice");
    });

    it("omits body when disabled", function () {
      const result = buildPRContent(samplePR, { body: false }, terms);
      expect(result.body).to.be.undefined;
    });
  });

  describe("comments option", function () {
    it("includes comments array when enabled", function () {
      const result = buildPRContent(
        samplePR,
        { comments: true, body: true, username: true, date: true },
        terms
      );
      expect(result.comments).to.be.an("array").with.length(2);
    });

    it("omits comments when disabled", function () {
      const result = buildPRContent(samplePR, { comments: false }, terms);
      expect(result.comments).to.be.undefined;
    });

    it("anonymizes comment body when body option is enabled", function () {
      const result = buildPRContent(
        samplePR,
        { comments: true, body: true },
        terms
      );
      expect(result.comments[0].body).to.not.include("Alice");
      expect(result.comments[0].body).to.include("XXXX-1");
    });

    it("omits comment body when body option is disabled", function () {
      const result = buildPRContent(
        samplePR,
        { comments: true, body: false },
        terms
      );
      expect(result.comments[0].body).to.be.undefined;
    });

    it("anonymizes comment author when username option is enabled", function () {
      const result = buildPRContent(
        samplePR,
        { comments: true, username: true },
        terms
      );
      expect(result.comments[0].author).to.not.include("Alice");
    });

    it("omits comment author when username option is disabled", function () {
      const result = buildPRContent(
        samplePR,
        { comments: true, username: false },
        terms
      );
      expect(result.comments[0].author).to.be.undefined;
    });

    it("includes comment dates when date option is enabled", function () {
      const result = buildPRContent(
        samplePR,
        { comments: true, date: true },
        terms
      );
      expect(result.comments[0].creationDate).to.deep.equal(
        new Date("2024-01-11")
      );
      expect(result.comments[0].updatedDate).to.deep.equal(
        new Date("2024-01-12")
      );
    });

    it("omits comment dates when date option is disabled", function () {
      const result = buildPRContent(
        samplePR,
        { comments: true, date: false },
        terms
      );
      expect(result.comments[0].creationDate).to.be.undefined;
      expect(result.comments[0].updatedDate).to.be.undefined;
    });
  });

  describe("diff option", function () {
    it("includes anonymized diff when enabled", function () {
      const result = buildPRContent(samplePR, { diff: true }, terms);
      expect(result.diff).to.exist;
      expect(result.diff).to.not.include("Alice");
      expect(result.diff).to.not.include("AuthorModule");
    });

    it("omits diff when disabled", function () {
      const result = buildPRContent(samplePR, { diff: false }, terms);
      expect(result.diff).to.be.undefined;
    });
  });

  describe("origin option", function () {
    it("includes baseRepositoryFullName when enabled", function () {
      const result = buildPRContent(samplePR, { origin: true }, terms);
      expect(result.baseRepositoryFullName).to.equal("alice/project");
    });

    it("omits baseRepositoryFullName when disabled", function () {
      const result = buildPRContent(samplePR, { origin: false }, terms);
      expect(result.baseRepositoryFullName).to.be.undefined;
    });
  });

  describe("date option", function () {
    it("includes root-level dates when enabled", function () {
      const result = buildPRContent(samplePR, { date: true }, terms);
      expect(result.updatedDate).to.deep.equal(new Date("2024-01-14"));
      expect(result.creationDate).to.deep.equal(new Date("2024-01-10"));
    });

    it("omits root-level dates when disabled", function () {
      const result = buildPRContent(samplePR, { date: false }, terms);
      expect(result.updatedDate).to.be.undefined;
      expect(result.creationDate).to.be.undefined;
    });
  });

  describe("all options enabled", function () {
    it("includes all fields, all anonymized", function () {
      const result = buildPRContent(
        samplePR,
        {
          title: true,
          body: true,
          comments: true,
          username: true,
          date: true,
          diff: true,
          origin: true,
        },
        terms
      );
      expect(result.title).to.exist;
      expect(result.body).to.exist;
      expect(result.comments).to.be.an("array");
      expect(result.diff).to.exist;
      expect(result.baseRepositoryFullName).to.exist;
      expect(result.updatedDate).to.exist;
      expect(result.creationDate).to.exist;
      // All sensitive terms should be masked
      expect(result.title).to.not.include("Alice");
      expect(result.body).to.not.include("Alice");
      expect(result.diff).to.not.include("Alice");
    });
  });

  describe("all options disabled", function () {
    it("only includes always-present fields", function () {
      const result = buildPRContent(samplePR, {}, terms);
      expect(result.merged).to.exist;
      expect(result.state).to.exist;
      expect(result.draft).to.exist;
      expect(result.title).to.be.undefined;
      expect(result.body).to.be.undefined;
      expect(result.comments).to.be.undefined;
      expect(result.diff).to.be.undefined;
      expect(result.baseRepositoryFullName).to.be.undefined;
      expect(result.updatedDate).to.be.undefined;
      expect(result.creationDate).to.be.undefined;
    });
  });

  describe("empty comments", function () {
    it("returns empty array when PR has no comments", function () {
      const pr = { ...samplePR, comments: [] };
      const result = buildPRContent(pr, { comments: true, body: true }, terms);
      expect(result.comments).to.be.an("array").with.length(0);
    });
  });
});
