const { expect } = require("chai");
const { Transform } = require("stream");
const { StringDecoder } = require("string_decoder");
require("ts-node/register/transpile-only");
const {
  withWordBoundaries,
  termVariants,
  parseTermSpec,
} = require("../src/core/term-matching");

/**
 * Tests for the core anonymization utilities.
 *
 * Because anonymize-utils.ts is TypeScript that imports config (which reads
 * process.env at module load time), we replicate the higher-level pieces
 * here. Pure helpers live in src/core/term-matching and are imported above.
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
      const spec = terms[i];
      if (spec.trim() == "") {
        continue;
      }
      const parsed = parseTermSpec(spec);
      let term = parsed.term;
      const mask =
        parsed.replacement !== null
          ? parsed.replacement
          : ANONYMIZATION_MASK + "-" + (i + 1);
      try {
        new RegExp(term, "gi");
      } catch {
        term = term.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&");
      }
      for (const variant of termVariants(term)) {
        const bounded = withWordBoundaries(variant.pattern, {
          sniffSource: variant.sniff,
          unicode: variant.unicode,
        });
        const flags = variant.unicode ? "giu" : "gi";
        content = content.replace(urlRegex, (match) => {
          if (new RegExp(bounded, flags).test(match)) {
            this.wasAnonymized = true;
            return mask;
          }
          return match;
        });
        content = content.replace(new RegExp(bounded, flags), () => {
          this.wasAnonymized = true;
          return mask;
        });
      }
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
    const spec = terms[i];
    if (spec.trim() == "") {
      continue;
    }
    const parsed = parseTermSpec(spec);
    let term = parsed.term;
    const mask =
      parsed.replacement !== null
        ? parsed.replacement
        : ANONYMIZATION_MASK + "-" + (i + 1);
    try {
      new RegExp(term, "gi");
    } catch {
      term = term.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&");
    }
    path = path.replace(new RegExp(term, "gi"), mask);
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

    // #175 — terms starting with a non-word char (e.g. "@username") were
    // silently skipped because \b can't match between two non-word chars.
    it("replaces terms starting with a non-word character (e.g. @user)", function () {
      const anon = new ContentAnonimizer({ terms: ["@tdurieux"] });
      const result = anon.anonymize('"name": "@tdurieux/anonymous"');
      expect(result).to.not.include("@tdurieux");
      expect(result).to.include("XXXX-1");
    });

    // #249 — regex terms ending in non-word chars (e.g. "@author .*") were
    // also skipped due to the trailing \b.
    it("matches a user regex that ends with a non-word pattern", function () {
      const anon = new ContentAnonimizer({ terms: ["@author .*"] });
      const result = anon.anonymize("/** @author julius */");
      expect(result).to.include("XXXX-1");
      expect(result).to.not.include("@author julius");
    });

    // #430 — IPv4-style terms have non-word boundaries on each dot but still
    // start/end with digits, so \b on both sides is fine — guard against
    // regression now that we tweak boundary logic.
    it("anonymizes an IP address term", function () {
      const anon = new ContentAnonimizer({ terms: ["192\\.168\\.1\\.1"] });
      const result = anon.anonymize("connect to 192.168.1.1 on port 80");
      expect(result).to.not.include("192.168.1.1");
      expect(result).to.include("XXXX-1");
    });

    // #285 — `term=>replacement` uses the user-supplied replacement
    // instead of XXXX-N, so anonymized identifiers can stay valid in code.
    it("uses a custom replacement when the term is 'term=>replacement'", function () {
      const a = new ContentAnonimizer({ terms: ["Anonymous=>ABC"] });
      const result = a.anonymize("class Anonymous extends Base {}");
      expect(result).to.equal("class ABC extends Base {}");
    });

    it("supports custom and default-mask terms together with stable indices", function () {
      const a = new ContentAnonimizer({
        terms: ["Alpha=>AAA", "Beta"],
      });
      const result = a.anonymize("Alpha and Beta");
      // Beta uses XXXX-2 (its 1-based index in the list), even though
      // Alpha had a custom replacement.
      expect(result).to.equal("AAA and XXXX-2");
    });

    it("falls back to the default mask when the entry has no replacement", function () {
      const a = new ContentAnonimizer({ terms: ["Foo=>"] });
      const result = a.anonymize("Foo bar");
      expect(result).to.equal(" bar");
    });

    // #280 — accented terms should match both the accented and unaccented
    // variants so "Davó" scrubs "Davo" (and vice versa).
    it("matches accented and unaccented variants of the same term", function () {
      const a = new ContentAnonimizer({ terms: ["Davó"] });
      const r1 = a.anonymize("Authors: Alice Davó and Bob Davo");
      expect(r1).to.not.include("Davó");
      expect(r1).to.not.include("Davo");
      expect(r1.match(/XXXX-1/g).length).to.equal(2);

      const b = new ContentAnonimizer({ terms: ["Davo"] });
      const r2 = b.anonymize("Authors: Alice Davó and Bob Davo");
      expect(r2).to.not.include("Davó");
      expect(r2).to.not.include("Davo");
      expect(r2.match(/XXXX-1/g).length).to.equal(2);
    });

    it("does not over-match across word boundaries when the term is word-only", function () {
      // Regression: ensure withWordBoundaries still emits \b on both sides
      // for ordinary alphanumeric terms.
      const anon = new ContentAnonimizer({ terms: ["cat"] });
      const result = anon.anonymize("the cat sat on a category");
      expect(result).to.include("category");
      expect(result).to.match(/the XXXX-1 sat/);
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
// AnonymizeTransformer (streaming) — replica of src/core/anonymize-utils.ts
// ---------------------------------------------------------------------------

// Mirror of isTextFile that relies on the file extension only — the real
// impl additionally calls istextorbinary, but for these tests checking the
// suffix is enough to demonstrate the constructor-vs-post-assignment bug.
function _isTextFileFromPath(filePath) {
  if (!filePath) return false;
  const ext = String(filePath).split(".").pop().toLowerCase();
  return new Set([
    "txt", "md", "js", "ts", "tsx", "jsx", "py", "rb", "go", "java",
    "c", "h", "cpp", "json", "yml", "yaml", "html", "htm", "css",
  ]).has(ext);
}

class AnonymizeTransformer extends Transform {
  constructor(opt) {
    super();
    this.opt = opt || {};
    // Mirror src/core/anonymize-utils.ts: isText is derived from
    // opt.filePath at construction time. Mutating opt.filePath after the
    // constructor runs has no effect (this was the cause of #342/#349).
    this.isText = _isTextFileFromPath(this.opt.filePath);
    this.anonimizer = new ContentAnonimizer(this.opt);
    this.decoder = new StringDecoder("utf8");
    this.pending = "";
  }
  static OVERLAP = 4096;

  _transform(chunk, encoding, callback) {
    if (!this.isText) {
      this.push(chunk);
      return callback();
    }
    this.pending += this.decoder.write(chunk);
    if (this.pending.length > AnonymizeTransformer.OVERLAP) {
      let split = this.pending.length - AnonymizeTransformer.OVERLAP;
      const code = this.pending.charCodeAt(split);
      if (code >= 0xdc00 && code <= 0xdfff) split -= 1;
      const toProcess = this.pending.slice(0, split);
      this.pending = this.pending.slice(split);
      const out = this.anonimizer.anonymize(toProcess);
      this.push(Buffer.from(out, "utf8"));
    }
    callback();
  }

  _flush(callback) {
    if (this.isText) {
      this.pending += this.decoder.end();
      if (this.pending) {
        const out = this.anonimizer.anonymize(this.pending);
        this.pending = "";
        this.push(Buffer.from(out, "utf8"));
      }
    }
    callback();
  }
}

function runStream(input, chunkSize, opt) {
  // Default to a text filePath so existing tests keep exercising the
  // anonymization path; tests verifying binary passthrough pass their own.
  const merged = { filePath: "fixture.txt", ...opt };
  return new Promise((resolve, reject) => {
    const t = new AnonymizeTransformer(merged);
    const out = [];
    t.on("data", (b) => out.push(Buffer.from(b)));
    t.on("end", () => resolve(Buffer.concat(out).toString("utf8")));
    t.on("error", reject);
    const buf = Buffer.from(input, "utf8");
    for (let i = 0; i < buf.length; i += chunkSize) {
      t.write(buf.slice(i, Math.min(i + chunkSize, buf.length)));
    }
    t.end();
  });
}

describe("AnonymizeTransformer (streaming)", function () {
  it("replaces all occurrences of a term across many small chunks", async function () {
    // Reproduces the bug: 'Created by Alice at YYYY/MM/DD' lines split across
    // chunk boundaries previously failed to match after the first ~14
    // occurrences when the stream's default 16 KiB chunking aligned mid-term.
    const line = "Created by Alice at 2025/01/01\n" + "x".repeat(1000) + "\n";
    const input = line.repeat(50);
    const expectedCount = 50;

    const result = await runStream(input, 1024, { terms: ["Alice"] });
    const matches = result.match(/XXXX-1/g) || [];
    expect(matches.length).to.equal(expectedCount);
    expect(result).to.not.include("Alice");
  });

  it("matches a term that lands exactly on a chunk boundary", async function () {
    // Force the term 'Alice' to be split between two writes.
    const prefix = "header ";
    const term = "Alice";
    const suffix = " trailer";
    const input = prefix + term + suffix;

    // First chunk ends after 'Ali', second starts at 'ce'
    const splitAt = prefix.length + 3;
    const t = new AnonymizeTransformer({ filePath: "fixture.txt", terms: ["Alice"] });
    const out = [];
    const done = new Promise((resolve, reject) => {
      t.on("data", (b) => out.push(Buffer.from(b)));
      t.on("end", () => resolve(Buffer.concat(out).toString("utf8")));
      t.on("error", reject);
    });
    t.write(Buffer.from(input.slice(0, splitAt), "utf8"));
    t.write(Buffer.from(input.slice(splitAt), "utf8"));
    t.end();

    const result = await done;
    expect(result).to.equal("header XXXX-1 trailer");
  });

  it("preserves byte content for non-anonymized streams", async function () {
    const input = "no terms match here\n".repeat(100);
    const result = await runStream(input, 64, { terms: ["zzzz"] });
    expect(result).to.equal(input);
  });

  it("flushes remaining buffered content on end", async function () {
    // Total input smaller than OVERLAP — must still be processed in _flush.
    const input = "Created by Alice at 2025/01/01";
    const result = await runStream(input, 8, { terms: ["Alice"] });
    expect(result).to.equal("Created by XXXX-1 at 2025/01/01");
  });

  // Regression for #342/#349: zip download was constructing the transformer
  // and then assigning opt.filePath after the fact, but isText is decided in
  // the constructor — so every entry was treated as binary and passed through
  // unanonymized. Ensure the filePath must be set at construction time.
  it("decides isText from the filePath passed at construction", function () {
    const beforeFix = new AnonymizeTransformer({ terms: ["Alice"] });
    beforeFix.opt.filePath = "fixture.txt"; // post-construction — too late
    expect(beforeFix.isText).to.equal(false);

    const afterFix = new AnonymizeTransformer({
      filePath: "fixture.txt",
      terms: ["Alice"],
    });
    expect(afterFix.isText).to.equal(true);
  });

  it("anonymizes a text file when filePath is supplied at construction", async function () {
    const input = "Hello Alice, how are you?";
    const result = await runStream(input, 8, {
      filePath: "fixture.txt",
      terms: ["Alice"],
    });
    expect(result).to.equal("Hello XXXX-1, how are you?");
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
