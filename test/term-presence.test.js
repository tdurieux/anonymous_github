const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { TermPresenceIndex } = require("../src/core/term-presence");
const { compileTerms, ContentAnonimizer } = require("../src/core/anonymize-utils");

function reference(terms, text) {
  const anonymizer = new ContentAnonimizer({ terms });
  anonymizer.termPresence = null;
  for (const term of anonymizer.compiledTerms) delete term.literalPrefilter;
  return anonymizer.anonymize(text);
}

describe("term candidate index", function () {
  it("retains shared prefixes, nested matches and Unicode-folded alternatives", function () {
    const patterns = [/Alice/iu, /AliceSmith/iu, /Smith/iu, /[sśŝşšș]/iu, /ſ/iu, /K/iu, /k/iu, /研究/iu];
    const index = new TermPresenceIndex(patterns);
    for (const text of ["AliceSmith", "ALICESMITH K ſ 研究", "nothing", "ś", "k", "aAliceSmith"]) {
      for (let after = -1; after < patterns.length; after++) {
        const candidates = index.candidates(text, after);
        patterns.forEach((pattern, i) => {
          if (i > after && pattern.test(text)) expect(candidates.has(i), `${text}: ${i}`).to.equal(true);
          if (i <= after) expect(candidates.has(i)).to.equal(false);
        });
      }
    }
  });

  it("keeps dot's CR and Unicode line-separator matches", function () {
    for (const text of ["first\rlast", "first\u2028last", "first\u2029last", "first\nlast", "first😀last"]) {
      expect(new ContentAnonimizer({ terms: ["first.last"] }).anonymize(text)).to.equal(reference(["first.last"], text));
    }
  });

  it("retains ordered cascades, URL removal, and matches created across replacement boundaries", function () {
    const cases = [
      [["Alice=>Bob", "Bob=>Hidden"], "Alice Bob https://host/Alice"],
      [["Alice=>", "@Bob=>Hidden"], "@AliceBob"],
      [["a-a", "Alice"], "xa-a-a Alice https://host/Alice/file"],
      [["first.last", "firstXlast=>other"], "firstXlast first.last"],
      [["Alice=>Bob", "Bob"], "https://host/Alice"],
      [["k", "s"], "K ſ ék k_ xK Kx"],
      [["Alice=>Bob", "B.b=>Done"], "Alice"],
      [["k=>Kk"], "https://host/k"],
      [["Alice=>$&", "Bob=>$$"], "Alice Bob"],
      [["\u0301"], "abc"],
      [["a.*b", "Alice"], "axxb Alice"],
    ];
    for (const [terms, text] of cases) {
      expect(new ContentAnonimizer({ terms }).anonymize(text), JSON.stringify([terms, text])).to.equal(reference(terms, text));
    }
  });

  it("matches the RE2 path for fixed-width terms and surrounding characters", function () {
    const terms = ["a-a", "a.a", "k", "s", "k.s", "Alice", "@Alice", "Σ", "研究", "😀", "..", "a.", "a..b"];
    const edges = ["", "x", "_", "é", "K", "ſ", "😀", "𐐀", "\r", "\n", "\u2028"];
    for (const term of terms) {
      const input = edges.flatMap(left => edges.map(right => `${left}${term}${right} ${left}${term.replaceAll(".", "\r")}${right}`)).join(" ");
      expect(new ContentAnonimizer({ terms: [term] }).anonymize(input), term).to.equal(reference([term], input));
    }
  });

  it("does not reuse stale rules after the caller edits its term list", function () {
    const terms = ["Alice=>first"];
    expect(new ContentAnonimizer({ terms }).anonymize("Alice")).to.equal("first");
    terms[0] = "Alice=>second";
    expect(new ContentAnonimizer({ terms }).anonymize("Alice")).to.equal("second");
    expect(new ContentAnonimizer({ terms: ["Alice=>first"] }).anonymize("Alice")).to.equal("first");
  });

  it("handles many matching rules and late cascades within the normal deadline", function () {
    this.timeout(10000);
    const names = Array.from({ length: 120 }, (_, i) => `Researcher${i} Laboratory Department`);
    const terms = names.map((name, i) => `${name}=>Person${i}`);
    terms.push("Person119=>FinalPerson", "@Person0=>Contact");
    const input = names.map(name => `@${name} contributed to this research.\n`).join("").repeat(3);
    const expected = names.map((_, i) => `${i === 0 ? "Contact" : i === 119 ? "@FinalPerson" : `@Person${i}`} contributed to this research.\n`).join("").repeat(3);
    expect(new ContentAnonimizer({ terms }).anonymize(input)).to.equal(expected);
  });

  it("can reuse candidate groups after an absent search and with different cutoffs", function () {
    const index = new TermPresenceIndex([/Alice/iu, /AliceSmith/iu, /Smith/iu, /研究/iu]);
    expect([...index.candidates("nothing")]).to.deep.equal([]);
    expect(index.candidates("AliceSmith 研究").has(2)).to.equal(true);
    expect([...index.candidates("AliceSmith 研究", 2)]).to.deep.equal([3]);
    expect(index.candidates("AliceSmith", -1).has(0)).to.equal(true);
  });

  it("does not index quantified, capturing, or escaped user patterns", function () {
    for (const term of ["a.*b", "a+b", "(Alice)", "a\\.b", "a(?=b)"]) {
      expect(compileTerms([term]).every(c => !c.literalPrefilter), term).to.equal(true);
    }
  });
});
