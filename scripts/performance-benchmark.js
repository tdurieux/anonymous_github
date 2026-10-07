const { performance, monitorEventLoopDelay } = require("node:perf_hooks");
const { strict: assert } = require("node:assert");
const { Readable, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { setTimeout: delay } = require("node:timers/promises");
const { setInterval, clearInterval } = require("node:timers");
require("ts-node/register/transpile-only");
const { compileTerms, anonymizePath, anonymizePathCompiled, AnonymizeTransformer } = require("../src/core/anonymize-utils");
const Repository = require("../src/core/Repository").default;
const { closeCacheRedis } = require("../src/core/cache-coordination");
const median = numbers => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
function originalSearch(files, q) {
  const folders = new Set();
  for (const file of files) {
    let accumulated = "";
    for (const segment of file.path.split("/")) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      if (segment.toLowerCase().includes(q)) folders.add(accumulated);
    }
  }
  return files.filter(file => {
    if (file.name.toLowerCase().includes(q)) return true;
    const fullPath = `${file.path}/${file.name}`;
    let found = false;
    folders.forEach(folder => { if (fullPath.startsWith(folder + "/") || fullPath === folder) found = true; });
    return found;
  }).slice(0, 500);
}
async function benchmark() {
  const results = [];
  if (!process.argv.includes("--memory-only")) {
    for (const count of [1000, 5000, 10000, 100000]) {
      const files = Array.from({ length: count }, (_, i) => ({ name: "data.txt", path: `folder-hit-${i}`, size: 10 }));
      const repo = { anonymizedFiles: async () => files };
      const old = [], current = [];
      for (let repeat = 0; repeat < 3; repeat++) {
        const started = performance.now();
        const actual = await Repository.prototype.searchFiles.call(repo, "hit");
        current.push(performance.now() - started);
        if (count <= 10000) {
          const baseline = performance.now();
          const expected = originalSearch(files, "hit");
          old.push(performance.now() - baseline); assert.deepEqual(actual, expected);
        }
      }
      results.push({ case: "search", files: count, medianMs: median(current), baselineMs: old.length ? median(old) : null,
        speedup: old.length ? median(old) / median(current) : null });
    }
    const terms = ["secret=>hidden", "Researcher", "University"];
    const paths = Array.from({ length: 10000 }, (_, i) => `src/secret/file${i}.ts`), old = [], current = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      let started = performance.now(); const expected = paths.map(p => anonymizePath(p, terms)); old.push(performance.now() - started);
      started = performance.now(); const compiled = compileTerms(terms); const actual = paths.map(p => anonymizePathCompiled(p, compiled)); current.push(performance.now() - started);
      assert.deepEqual(actual, expected);
    }
    results.push({ case: "compile-once paths", files: paths.length, medianMs: median(current), baselineMs: median(old), speedup: median(old) / median(current) });
  }
  if (process.argv.includes("--memory") || process.argv.includes("--memory-only")) {
    const size = Number(process.env.PERF_FILE_MIB) || 48, count = Number(process.env.PERF_CONCURRENCY) || 4;
    const before = process.memoryUsage().rss;
    let peak = before, output = 0;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
    const histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable();
    await delay(30);
    const started = performance.now();
    await Promise.all(Array.from({ length: count }, (_, i) => pipeline(
      Readable.from((async function* () { for (let chunk = 0; chunk < size * 16; chunk++) yield Buffer.alloc(65536, 65); })()),
      new AnonymizeTransformer({ filePath: `memory-${i}.txt`, terms: ["Alice"], cacheGeneration: String(Date.now()) }),
      new Writable({ write(chunk, _encoding, callback) { output += chunk.length; callback(); } })
    )));
    histogram.disable(); clearInterval(timer);
    results.push({ case: "large text", concurrent: count, fileMiB: size, elapsedMs: performance.now() - started,
      outputMiB: output / 1048576, peakRssMiB: peak / 1048576, rssIncreaseMiB: (peak - before) / 1048576,
      eventLoopP95Ms: histogram.percentile(95) / 1e6, eventLoopMaxMs: histogram.max / 1e6 });
  }
  await closeCacheRedis();
  console.log(JSON.stringify({ node: process.version, results }, null, 2));
}
benchmark().catch(error => { console.error(error); process.exitCode = 1; });
