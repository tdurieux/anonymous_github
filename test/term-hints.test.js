const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { termHints, escapeTermLine } = require("../src/core/term-hints");

describe("term hints", function () {
  it("ignores dots, hyphens and emails", function () {
    expect(termHints("mchen-research\nhartwell.edu\nmaya.chen@cs.example.edu\nA, B #1")).to.deep.equal([]);
  });

  it("flags symbols that change what a term matches", function () {
    expect(termHints("Maya Chen\nSmith (MIT)\nC++")).to.deep.equal([
      { line: 1, term: "Smith (MIT)", symbols: ["(", ")"] },
      { line: 2, term: "C++", symbols: ["+"] },
    ]);
  });

  it("skips escaped symbols and the replacement side", function () {
    expect(termHints("Smith \\(MIT\\)\nAnon=>A (B)")).to.deep.equal([]);
  });

  it("escapes one line and keeps its replacement", function () {
    expect(escapeTermLine("a\nSmith (MIT).x=>Anon (1)\nb", 1)).to.equal("a\nSmith \\(MIT\\)\\.x=>Anon (1)\nb");
    expect(escapeTermLine("C\\+\\+ +", 0)).to.equal("C\\+\\+ \\+");
  });

  it("inserts terms containing $ sequences literally", function () {
    expect(escapeTermLine("a$&b (x)", 0)).to.equal("a\\$&b \\(x\\)");
    expect(escapeTermLine("  $'(y)=>z", 0)).to.equal("  \\$'\\(y\\)=>z");
    expect(escapeTermLine("$1+", 0)).to.equal("\\$1\\+");
  });
});
