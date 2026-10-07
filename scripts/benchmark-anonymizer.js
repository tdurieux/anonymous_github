// Run with node scripts/benchmark-anonymizer.js [path-to-anonymize-utils.ts].
// Fixtures are synthetic; reported timings exclude fixture creation and I/O.
const path = require("node:path");
const { performance } = require("node:perf_hooks");
require("ts-node/register/transpile-only");
const { ContentAnonimizer } = require(process.argv[2]
  ? path.resolve(process.argv[2]) : "../src/core/anonymize-utils");
const terms = ["first.last", "user@example.org", "dept.example.edu", "lab.io", "project.org", "Author X. Name",
  ...Array.from({ length: 41 }, (_, i) => `Researcher${i}`)];
const row = "123,456,78.91234,-45.123456\n";
const cases = [
  ["2 MB CSV, 47 absent terms", () => row.repeat(70000), terms],
  ["100 MB CSV, 47 absent terms", () => row.repeat(3600000), terms],
  ["50 MB CSV, sparse matches", () => `first.last\n${row.repeat(1800000)}\nhttps://host/user@example.org`, terms],
  ["22 MB text, 1.2 million replacements", () => "Alice 123 first.last,45.678,-23.456\n".repeat(600000), ["Alice", ...terms]],
];
for (const [name, fixture, rules] of cases) {
  const input = fixture();
  const startCompile = performance.now();
  const anonymizer = new ContentAnonimizer({ terms: rules });
  const compileMs = performance.now() - startCompile;
  const started = performance.now();
  try {
    const output = anonymizer.anonymize(input);
    console.log(JSON.stringify({ name, inputBytes: Buffer.byteLength(input), outputBytes: Buffer.byteLength(output),
      compileMs: +compileMs.toFixed(1), matchMs: +(performance.now() - started).toFixed(1) }));
  } catch (error) {
    console.log(JSON.stringify({ name, inputBytes: Buffer.byteLength(input),
      compileMs: +compileMs.toFixed(1), matchMs: +(performance.now() - started).toFixed(1), error: error.code || error.message }));
  }
}
