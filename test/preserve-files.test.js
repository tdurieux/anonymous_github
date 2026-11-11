const { expect } = require("chai");
require("ts-node/register/transpile-only");
const {
  isPreservedPath,
  normalizePreserveFiles,
} = require("../src/core/preserve-files");
const { AnonymizeTransformer } = require("../src/core/anonymize-utils");
const { decisionKey } = require("../src/core/cached-response");

function run(options, input) {
  const transformer = new AnonymizeTransformer(options);
  const chunks = [];
  return new Promise((resolve, reject) => {
    transformer.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    transformer.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    transformer.on("error", reject);
    transformer.end(Buffer.from(input));
  });
}

describe("preserveFiles (#941)", function () {
  describe("isPreservedPath", function () {
    it("matches a bare name or glob in any folder", function () {
      expect(isPreservedPath("refs.bib", ["refs.bib"])).to.equal(true);
      expect(isPreservedPath("paper/refs.bib", ["refs.bib"])).to.equal(true);
      expect(isPreservedPath("a/b/other.bib", ["*.bib"])).to.equal(true);
      expect(isPreservedPath("paper/refs.tex", ["*.bib"])).to.equal(false);
    });

    it("anchors patterns containing a slash at the repository root", function () {
      expect(isPreservedPath("paper/refs.bib", ["paper/refs.bib"])).to.equal(true);
      expect(isPreservedPath("x/paper/refs.bib", ["paper/refs.bib"])).to.equal(false);
      expect(isPreservedPath("paper/sub/a.bib", ["paper/**"])).to.equal(true);
    });

    it("anchors a leading slash at the root, like .gitignore", function () {
      expect(isPreservedPath("refs.bib", ["/refs.bib"])).to.equal(true);
      expect(isPreservedPath("paper/refs.bib", ["/refs.bib"])).to.equal(false);
      expect(isPreservedPath("paper/refs.bib", ["/paper/refs.bib"])).to.equal(true);
    });

    it("matches picked paths escaped with backslashes, braces included", function () {
      expect(isPreservedPath("paper/[draft].bib", ["/paper/\\[draft\\].bib"])).to.equal(true);
      expect(isPreservedPath("paper/d.bib", ["/paper/\\[draft\\].bib"])).to.equal(false);
      expect(isPreservedPath("paper/{draft,final}.bib", ["/paper/\\{draft,final\\}.bib"])).to.equal(true);
      expect(isPreservedPath("paper/draft.bib", ["/paper/\\{draft,final\\}.bib"])).to.equal(false);
    });

    it("applies folder rules to everything inside, like .gitignore", function () {
      expect(isPreservedPath("private/refs.bib", ["*.bib", "!private"])).to.equal(false);
      expect(isPreservedPath("paper/private/refs.bib", ["*.bib", "!private/"])).to.equal(false);
      expect(isPreservedPath("paper/refs.bib", ["*.bib", "!private"])).to.equal(true);
      expect(isPreservedPath("paper/a/b.tex", ["paper"])).to.equal(true);
      expect(isPreservedPath("x/paper/b.tex", ["/paper"])).to.equal(false);
      expect(isPreservedPath("private.bib", ["*.bib", "!private/"])).to.equal(true);
      expect(isPreservedPath("private/x.bib", ["/private/x.bib", "!/private/"])).to.equal(false);
    });

    it("applies !patterns as exclusions, last match wins", function () {
      const patterns = ["*.bib", "!private.bib"];
      expect(isPreservedPath("paper/refs.bib", patterns)).to.equal(true);
      expect(isPreservedPath("paper/private.bib", patterns)).to.equal(false);
      expect(isPreservedPath("README.md", patterns)).to.equal(false);
      expect(isPreservedPath("paper/private.bib", ["!private.bib", "*.bib"])).to.equal(true);
      expect(isPreservedPath("a/x.bib", ["a/**", "!a/*.bib"])).to.equal(false);
      expect(isPreservedPath("#notes.txt", ["#notes.txt"])).to.equal(true);
    });

    it("matches dotfiles and ignores empty input", function () {
      expect(isPreservedPath(".zenodo.json", ["*.json"])).to.equal(true);
      expect(isPreservedPath("refs.bib", [])).to.equal(false);
      expect(isPreservedPath("", ["*"])).to.equal(false);
      expect(isPreservedPath("refs.bib", undefined)).to.equal(false);
    });
  });

  describe("normalizePreserveFiles", function () {
    it("trims, drops blanks and duplicates", function () {
      expect(normalizePreserveFiles([" refs.bib ", "", "refs.bib", "*.bib"]))
        .to.deep.equal(["refs.bib", "*.bib"]);
    });

    it("keeps the last copy of a repeated rule so the result does not change", function () {
      const raw = ["!a.bib", "*.bib", "!a.bib"];
      const normalized = normalizePreserveFiles(raw);
      expect(normalized).to.deep.equal(["*.bib", "!a.bib"]);
      expect(isPreservedPath("a.bib", normalized)).to.equal(isPreservedPath("a.bib", raw));
      expect(isPreservedPath("a.bib", normalized)).to.equal(false);
      expect(normalizePreserveFiles(undefined)).to.deep.equal([]);
      expect(normalizePreserveFiles(["!private/", "paper/"])).to.deep.equal(["!private/", "paper/"]);
      expect(normalizePreserveFiles(["/refs.bib", "!private.bib", "/a\\{b\\}"])).to.deep.equal(["/refs.bib", "!private.bib", "/a\\{b\\}"]);
    });

    it("rejects invalid input", function () {
      expect(normalizePreserveFiles("refs.bib")).to.equal(null);
      expect(normalizePreserveFiles([1])).to.equal(null);
      expect(normalizePreserveFiles(["//x"])).to.equal(null);
      expect(normalizePreserveFiles(["/"])).to.equal(null);
      expect(normalizePreserveFiles(["../x"])).to.equal(null);
      expect(normalizePreserveFiles(["!"])).to.equal(null);
      expect(normalizePreserveFiles(["!/"])).to.equal(null);
      expect(normalizePreserveFiles(["//"])).to.equal(null);
      expect(normalizePreserveFiles(["!../x"])).to.equal(null);
      expect(normalizePreserveFiles(["x".repeat(513)])).to.equal(null);
      expect(normalizePreserveFiles(Array.from({ length: 201 }, (_, i) => `f${i}`))).to.equal(null);
    });
  });

  describe("AnonymizeTransformer", function () {
    const bib = "@article{smith2024, author = {Jane Smith}}";

    it("leaves matching files unredacted", async function () {
      const out = await run({ filePath: "paper/refs.bib", terms: ["Smith"], preserveFiles: ["*.bib"] }, bib);
      expect(out).to.equal(bib);
    });

    it("still redacts files that do not match", async function () {
      const out = await run({ filePath: "paper/main.tex", terms: ["Smith"], preserveFiles: ["*.bib"] }, "by Jane Smith");
      expect(out).to.equal("by Jane XXXX-1");
    });

    it("keeps the full options for re-evaluation downstream", function () {
      const t = new AnonymizeTransformer({ filePath: "refs.bib", terms: ["Smith"], preserveFiles: ["refs.bib"] });
      expect(t.opt.terms).to.deep.equal(["Smith"]);
    });
  });

  it("changes cache keys when the pattern list changes", function () {
    const base = { filePath: "refs.bib", terms: ["Smith"] };
    expect(decisionKey("d", { ...base, preserveFiles: [] }))
      .to.not.equal(decisionKey("d", { ...base, preserveFiles: ["refs.bib"] }));
  });
});
