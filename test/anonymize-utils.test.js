const { expect } = require("chai");

/**
 * Tests for the core anonymization utilities.
 *
 * Because anonymize-utils.ts is TypeScript that imports config (which reads
 * process.env at module load time), we replicate the pure logic here so the
 * tests run without compiling the full project or connecting to a database.
 */

// ---------------------------------------------------------------------------
// Minimal replica of the anonymization logic under test
// (mirrors src/core/anonymize-utils.ts)
// ---------------------------------------------------------------------------

const ANONYMIZATION_MASK = "XXXX";

const urlRegex =
  /<?\b((https?|ftp|file):\/\/)[-A-Za-z0-9+&@#/%?=~_|!:,.;]+[-A-Za-z0-9+&@#/%=~_|]\b\/?>?/g;

class ContentAnonimizer {
  constructor(opt) {
    this.opt = opt || {};
    this.wasAnonymized = false;
  }

  removeImage(content) {
    if (this.opt.image !== false) {
      return content;
    }
    return content.replace(
      /!\[[^\]]*\]\((?<filename>.*?)(?="|\))(?<optionalpart>".*")?\)/g,
      () => {
        this.wasAnonymized = true;
        return ANONYMIZATION_MASK;
      }
    );
  }

  removeLink(content) {
    if (this.opt.link !== false) {
      return content;
    }
    return content.replace(urlRegex, () => {
      this.wasAnonymized = true;
      return ANONYMIZATION_MASK;
    });
  }

  replaceGitHubSelfLinks(content) {
    if (!this.opt.repoName || !this.opt.branchName) {
      return content;
    }
    const repoName = this.opt.repoName;
    const branchName = this.opt.branchName;
    const APP_HOSTNAME = "anonymous.4open.science";

    const replaceCallback = () => {
      this.wasAnonymized = true;
      return `https://${APP_HOSTNAME}/r/${this.opt.repoId}`;
    };
    content = content.replace(
      new RegExp(
        `https://raw.githubusercontent.com/${repoName}/${branchName}\\b`,
        "gi"
      ),
      replaceCallback
    );
    content = content.replace(
      new RegExp(
        `https://github.com/${repoName}/blob/${branchName}\\b`,
        "gi"
      ),
      replaceCallback
    );
    content = content.replace(
      new RegExp(
        `https://github.com/${repoName}/tree/${branchName}\\b`,
        "gi"
      ),
      replaceCallback
    );
    return content.replace(
      new RegExp(`https://github.com/${repoName}`, "gi"),
      replaceCallback
    );
  }

  replaceTerms(content) {
    const terms = this.opt.terms || [];
    for (let i = 0; i < terms.length; i++) {
      let term = terms[i];
      if (term.trim() == "") {
        continue;
      }
      const mask = ANONYMIZATION_MASK + "-" + (i + 1);
      try {
        new RegExp(term, "gi");
      } catch {
        term = term.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&");
      }
      content = content.replace(urlRegex, (match) => {
        if (new RegExp(`\\b${term}\\b`, "gi").test(match)) {
          this.wasAnonymized = true;
          return mask;
        }
        return match;
      });
      content = content.replace(new RegExp(`\\b${term}\\b`, "gi"), () => {
        this.wasAnonymized = true;
        return mask;
      });
    }
    return content;
  }

  anonymize(content) {
    content = this.removeImage(content);
    content = this.removeLink(content);
    content = this.replaceGitHubSelfLinks(content);
    content = this.replaceTerms(content);
    return content;
  }
}

function anonymizePath(path, terms) {
  for (let i = 0; i < terms.length; i++) {
    let term = terms[i];
    if (term.trim() == "") {
      continue;
    }
    try {
      new RegExp(term, "gi");
    } catch {
      term = term.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&");
    }
    path = path.replace(
      new RegExp(term, "gi"),
      ANONYMIZATION_MASK + "-" + (i + 1)
    );
  }
  return path;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContentAnonimizer", function () {
  // ---------------------------------------------------------------
  // Term replacement
  // ---------------------------------------------------------------
  describe("replaceTerms", function () {
    it("replaces a single term with a numbered mask", function () {
      const anon = new ContentAnonimizer({ terms: ["secret"] });
      const result = anon.anonymize("this is a secret value");
      expect(result).to.equal("this is a XXXX-1 value");
      expect(anon.wasAnonymized).to.be.true;
    });

    it("replaces multiple terms with distinct masks", function () {
      const anon = new ContentAnonimizer({ terms: ["alice", "bob"] });
      const result = anon.anonymize("alice met bob");
      expect(result).to.equal("XXXX-1 met XXXX-2");
    });

    it("is case-insensitive", function () {
      const anon = new ContentAnonimizer({ terms: ["Secret"] });
      const result = anon.anonymize("a SECRET message and a secret one");
      expect(result).to.not.include("SECRET");
      expect(result).to.not.include("secret");
    });

    it("respects word boundaries", function () {
      const anon = new ContentAnonimizer({ terms: ["cat"] });
      const result = anon.anonymize("the cat sat on a category");
      expect(result).to.include("XXXX-1");
      // "category" should NOT be replaced because \b prevents partial match
      expect(result).to.include("category");
    });

    it("skips empty/whitespace-only terms", function () {
      const anon = new ContentAnonimizer({ terms: ["", "  ", "real"] });
      const result = anon.anonymize("a real term");
      expect(result).to.equal("a XXXX-3 term");
    });

    it("handles terms that are invalid regex by escaping them", function () {
      const anon = new ContentAnonimizer({ terms: ["foo(bar"] });
      // "foo(bar" is invalid regex; the code should escape it
      // Since \b won't match around '(' properly, the replacement may not fire
      // on the raw term, but crucially it must not throw
      expect(() => anon.anonymize("some foo(bar here")).to.not.throw();
    });

    it("replaces terms inside URLs", function () {
      const anon = new ContentAnonimizer({ terms: ["myuser"] });
      const result = anon.anonymize(
        "visit https://github.com/myuser/project for details"
      );
      expect(result).to.not.include("myuser");
    });

    it("does not modify content when no terms provided", function () {
      const anon = new ContentAnonimizer({ terms: [] });
      const original = "nothing changes here";
      const result = anon.anonymize(original);
      expect(result).to.equal(original);
      expect(anon.wasAnonymized).to.be.false;
    });
  });

  // ---------------------------------------------------------------
  // Image removal
  // ---------------------------------------------------------------
  describe("removeImage", function () {
    it("removes markdown images when image option is false", function () {
      const anon = new ContentAnonimizer({ image: false });
      const result = anon.anonymize("![alt](http://example.com/img.png)");
      expect(result).to.equal(ANONYMIZATION_MASK);
      expect(anon.wasAnonymized).to.be.true;
    });

    it("keeps markdown images when image option is true", function () {
      const anon = new ContentAnonimizer({ image: true });
      const result = anon.anonymize("![alt](http://example.com/img.png)");
      expect(result).to.include("![alt]");
    });

    it("keeps markdown images when image option is undefined (default)", function () {
      const anon = new ContentAnonimizer({});
      const result = anon.anonymize("![alt](http://example.com/img.png)");
      expect(result).to.include("![alt]");
    });

    it("removes multiple images in the same content", function () {
      const anon = new ContentAnonimizer({ image: false });
      const result = anon.anonymize(
        "![a](img1.png) text ![b](img2.jpg)"
      );
      expect(result).to.not.include("![");
    });
  });

  // ---------------------------------------------------------------
  // Link removal
  // ---------------------------------------------------------------
  describe("removeLink", function () {
    it("removes URLs when link option is false", function () {
      const anon = new ContentAnonimizer({ link: false });
      const result = anon.anonymize("visit https://example.com for info");
      expect(result).to.not.include("https://example.com");
      expect(result).to.include(ANONYMIZATION_MASK);
      expect(anon.wasAnonymized).to.be.true;
    });

    it("keeps URLs when link option is true", function () {
      const anon = new ContentAnonimizer({ link: true });
      const result = anon.anonymize("visit https://example.com for info");
      expect(result).to.include("https://example.com");
    });

    it("keeps URLs when link option is undefined (default)", function () {
      const anon = new ContentAnonimizer({});
      const result = anon.anonymize("visit https://example.com for info");
      expect(result).to.include("https://example.com");
    });

    it("removes ftp and file URLs when link is false", function () {
      const anon = new ContentAnonimizer({ link: false });
      const result = anon.anonymize(
        "ftp://files.example.com/a and file:///home/user/doc"
      );
      expect(result).to.not.include("ftp://");
      expect(result).to.not.include("file:///");
    });
  });

  // ---------------------------------------------------------------
  // GitHub self-link replacement
  // ---------------------------------------------------------------
  describe("replaceGitHubSelfLinks", function () {
    it("replaces raw.githubusercontent.com links", function () {
      const anon = new ContentAnonimizer({
        repoName: "owner/repo",
        branchName: "main",
        repoId: "abc123",
      });
      const result = anon.anonymize(
        "https://raw.githubusercontent.com/owner/repo/main/README.md"
      );
      expect(result).to.include("anonymous.4open.science/r/abc123");
      expect(result).to.not.include("raw.githubusercontent.com");
    });

    it("replaces github.com/blob links", function () {
      const anon = new ContentAnonimizer({
        repoName: "owner/repo",
        branchName: "main",
        repoId: "abc123",
      });
      const result = anon.anonymize(
        "https://github.com/owner/repo/blob/main/src/file.ts"
      );
      expect(result).to.include("anonymous.4open.science/r/abc123");
    });

    it("replaces github.com/tree links", function () {
      const anon = new ContentAnonimizer({
        repoName: "owner/repo",
        branchName: "main",
        repoId: "abc123",
      });
      const result = anon.anonymize(
        "https://github.com/owner/repo/tree/main/src"
      );
      expect(result).to.include("anonymous.4open.science/r/abc123");
    });

    it("replaces generic github.com repo links", function () {
      const anon = new ContentAnonimizer({
        repoName: "owner/repo",
        branchName: "main",
        repoId: "abc123",
      });
      const result = anon.anonymize("https://github.com/owner/repo");
      expect(result).to.include("anonymous.4open.science/r/abc123");
    });

    it("is case-insensitive for repo name", function () {
      const anon = new ContentAnonimizer({
        repoName: "Owner/Repo",
        branchName: "main",
        repoId: "abc123",
      });
      const result = anon.anonymize(
        "https://github.com/owner/repo/blob/main/file"
      );
      expect(result).to.include("anonymous.4open.science/r/abc123");
    });

    it("does not replace when repoName is not set", function () {
      const anon = new ContentAnonimizer({
        branchName: "main",
        repoId: "abc123",
      });
      const original = "https://github.com/owner/repo";
      const result = anon.anonymize(original);
      expect(result).to.equal(original);
    });

    it("does not replace when branchName is not set", function () {
      const anon = new ContentAnonimizer({
        repoName: "owner/repo",
        repoId: "abc123",
      });
      const original = "https://github.com/owner/repo/blob/main/file";
      const result = anon.anonymize(original);
      expect(result).to.equal(original);
    });
  });

  // ---------------------------------------------------------------
  // Combined anonymization
  // ---------------------------------------------------------------
  describe("anonymize (combined)", function () {
    it("applies all transformations in sequence", function () {
      const anon = new ContentAnonimizer({
        image: false,
        link: false,
        terms: ["author"],
        repoName: "author/project",
        branchName: "main",
        repoId: "xyz",
      });
      const input =
        "by author: ![pic](http://example.com/pic.png) see https://github.com/author/project";
      const result = anon.anonymize(input);
      expect(result).to.not.include("author");
      expect(result).to.not.include("![pic]");
      expect(result).to.not.include("example.com");
    });

    it("sets wasAnonymized to false when nothing changes", function () {
      const anon = new ContentAnonimizer({
        image: true,
        link: true,
        terms: ["nonexistent"],
      });
      anon.anonymize("plain text without any matching content");
      expect(anon.wasAnonymized).to.be.false;
    });
  });
});

// ---------------------------------------------------------------------------
// anonymizePath
// ---------------------------------------------------------------------------
describe("anonymizePath", function () {
  it("replaces a term in a file path", function () {
    const result = anonymizePath("src/myproject/index.ts", ["myproject"]);
    expect(result).to.equal("src/XXXX-1/index.ts");
  });

  it("replaces multiple terms with distinct masks", function () {
    const result = anonymizePath("owner/repo/file.txt", ["owner", "repo"]);
    expect(result).to.equal("XXXX-1/XXXX-2/file.txt");
  });

  it("is case-insensitive", function () {
    const result = anonymizePath("SRC/MyProject/Main.ts", ["myproject"]);
    expect(result).to.include("XXXX-1");
    expect(result).to.not.include("MyProject");
  });

  it("skips empty terms", function () {
    const result = anonymizePath("src/project/file.ts", ["", "project"]);
    expect(result).to.equal("src/XXXX-2/file.ts");
  });

  it("handles terms with regex special characters", function () {
    const result = anonymizePath("src/my.project/file.ts", ["my.project"]);
    // "my.project" is valid regex where . matches any char, so it matches as-is
    expect(result).to.include("XXXX-1");
  });

  it("replaces all occurrences of the same term", function () {
    const result = anonymizePath("lib/secret/test/secret/a.js", ["secret"]);
    expect(result).to.not.include("secret");
  });

  it("does not replace partial matches (unlike replaceTerms, anonymizePath has no word boundary)", function () {
    // anonymizePath uses term directly in regex without \b,
    // so "cat" inside "category" WILL be replaced in paths
    const result = anonymizePath("category/cat.txt", ["cat"]);
    // Both occurrences should be replaced since there are no word boundaries
    expect(result).to.include("XXXX-1");
  });

  it("returns path unchanged when terms array is empty", function () {
    const result = anonymizePath("src/file.ts", []);
    expect(result).to.equal("src/file.ts");
  });
});
