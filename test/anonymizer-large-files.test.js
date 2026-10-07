const { expect } = require("chai");
const { Readable } = require("node:stream");
require("ts-node/register/transpile-only");
const { AnonymizeTransformer, ContentAnonimizer } = require("../src/core/anonymize-utils");
const terms = ["first.last", "user@example.org", "dept.example.edu", "lab.io", "project.org", "Author X. Name",
  ...Array.from({ length: 41 }, (_, i) => `Researcher${i}`)];

describe("large files with many anonymization terms", function () {
  this.timeout(10000);
  it("handles a 50 MB numeric dataset without exhausting the one-second deadline", function () {
    const input = "123,456,78.91234,-45.123456\n".repeat(1800000);
    expect(new ContentAnonimizer({ terms }).anonymize(input)).to.equal(input);
  });
  it("redacts dotted terms and their URLs around a large payload", async function () {
    const payload = "123,456,78.91234,-45.123456\n".repeat(200000);
    const input = Buffer.from(`first.last\n${payload}\nhttps://host/user@example.org/path\nfirstXlast`);
    const stream = new AnonymizeTransformer({ filePath: "coords.csv", terms });
    Readable.from([input.subarray(0, 6), input.subarray(6)]).pipe(stream);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).to.equal(`XXXX-1\n${payload}\nXXXX-2\nXXXX-1`);
  });
  it("handles many repeated matches while preserving the surrounding values", function () {
    const input = "Alice,123,45.678,-23.456\n".repeat(100000);
    expect(new ContentAnonimizer({ terms: ["Alice", ...terms] }).anonymize(input))
      .to.equal("XXXX-1,123,45.678,-23.456\n".repeat(100000));
  });
});
