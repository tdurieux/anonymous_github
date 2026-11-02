const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { ContentAnonimizer } = require("../src/core/anonymize-utils");

function unfiltered(terms, text) {
  const a = new ContentAnonimizer({ terms });
  a.termPresence = null;
  for (const term of a.compiledTerms) delete term.requiredPrefix;
  return a.anonymize(text);
}

describe("regex required-prefix searches", function () {
  it("keeps RE2 results for assertions, escaped punctuation, optional atoms and quantifiers", function () {
    const terms = [String.raw`\b[Aa]uthor\b`, String.raw`\Bauthor\B`, String.raw`author\.example\.org`,
      "Research[ _-]?Institute", "a?b?c?d?e?required", "a??bc", "a+b", "a*b", "a{0,2}b", "a{2}b",
      String.raw`\(Author\)`, String.raw`\ba?\b`, "[a-z]Name", "[^x]Name", "a|b", "(a)?b", "^Author", "Author$",
      String.raw`Author\s+Name`, String.raw`Author\d+`, String.raw`Author\x41`, "Σ?Author", "😀?Author"];
    const text = "Author author xauthorx author.example.org authorXexampleYorg Research-Institute Research Institute " +
      "ResearchInstitute required aaaaab ab b aabc abc (Author) aName xName Author Name Author12 AuthorA ΣAuthor 😀Author";
    for (const term of terms) {
      const a = new ContentAnonimizer({ terms: [term] });
      expect(a.anonymize(text), term).to.equal(unfiltered([term], text));
    }
  });

  it("preserves cascades, anchors and external boundaries after skipping unmatched prefixes", function () {
    const cases = [
      [[String.raw`\bAuthor\b=>Research Institute`, "Research[ _-]?Institute=>Hidden"], "Author"],
      [["a?bc=>Hidden"], "xbc abc bc abcx abc"],
      [["a+b=>Hidden"], "xaaab aaab aabx ab"],
      [[String.raw`\b[Aa]uthor\b=>Hidden`], "éAuthor Authoré Author xAuthor Author"],
      [[String.raw`\bAuthor\b=>Hidden`], "😀Author\nAuthor😀"],
      [["a?=>X"], "xyz"],
      [["a{0}=>X"], "xyz"],
      [[String.raw`\bAuthor\b=>First`, "^First=>Second", "Second$=>Last"], "Author"],
    ];
    for (const [terms, text] of cases) {
      expect(new ContentAnonimizer({ terms }).anonymize(text), JSON.stringify(terms)).to.equal(unfiltered(terms, text));
    }
  });

  it("processes sparse boundary and optional regex rules in a large file within the worker deadline", function () {
    this.timeout(20000);
    const body = "const value = [1,2,3,4,5]; // ordinary application data\n".repeat(290000);
    const input = `Author Research Project\n${body}\nAuthor`;
    const terms = [String.raw`\b[Aa]uthor\b=>Hidden`, "Research[ _-]?Institute=>Organization",
      ...Array.from({ length: 24 }, (_, i) => String.raw`\bResearcher${i}\b=>Hidden`),
      String.raw`research\.example\.org=>Website`];
    const a = new ContentAnonimizer({ terms });
    expect(a.anonymize(input, 10000)).to.equal(`Hidden Research Project\n${body}\nHidden`);
  });
});
