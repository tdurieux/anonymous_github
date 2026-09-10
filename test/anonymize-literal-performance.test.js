const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { Readable } = require("stream");
const { ContentAnonimizer, AnonymizeTransformer } = require("../src/core/anonymize-utils");

describe("literal term presence checks", function () {
  it("serves a large JavaScript file with absent names within the anonymization deadline", async function () {
    const input = Buffer.from('function render(){return "application content";}\n'.repeat(65000));
    const transformer = new AnonymizeTransformer({
      filePath: "main.js",
      terms: Array.from({ length: 20 }, (_, i) => `Researcher${i}`),
      image: true,
      link: true,
    });
    const chunks = [];
    Readable.from([input.subarray(0, 65536), input.subarray(65536)]).pipe(transformer);
    for await (const chunk of transformer) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(input)).to.equal(true);
  });

  it("preserves RE2 replacements, Unicode case folding, and boundaries", function () {
    const cases = [
      { terms: ["Alice"], text: "ALICE Alice Álîce Malice Alice2 éAlice Aliceé" },
      { terms: ["Davo"], text: "Davó DAVO Davoé éDavo" },
      { terms: ["Davó"], text: "Davo DAVÓ Davó" },
      { terms: ["k", "s"], text: "k K K s S ſ éK ſé" },
      { terms: ["Σ", "Ж", "研究"], text: "Σ σ ς Ж ж 研究" },
      { terms: ["@Alice", "Alice-Bob"], text: "@Álice @Alice Alice-Bob" },
      { terms: ["Alice=>Bob", "Bob=>$&"], text: "Alice and Bob" },
      { terms: ["a.*b", "a(?=b)", "a\\.b"], text: "a.b ab axxb" },
    ];
    for (const { terms, text } of cases) {
      const reference = new ContentAnonimizer({ terms });
      // Compare against the existing matcher without its optional shortcut.
      for (const term of reference.compiledTerms) delete term.literalPrefilter;
      const optimized = new ContentAnonimizer({ terms });
      expect(optimized.anonymize(text)).to.equal(reference.anonymize(text));
      expect(optimized.wasAnonymized).to.equal(reference.wasAnonymized);
    }
  });
});
