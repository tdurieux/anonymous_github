// Synthetic metadata only. No network or database is used by this process.
const assert = require("node:assert/strict");
require("ts-node/register/transpile-only");
const GitHubStream = require("../../src/core/source/GitHubStream").default;
const source = new GitHubStream({ repoId: "heap-fixture", organization: "fixture", repoName: "large",
  commit: "head", getToken: () => "fixture-token" });
const pageSize = 10000, pages = Number(process.env.TREE_FIXTURE_PAGES || 200);
source.getGHTree = async (_oct, _token, sha, _count, options) => {
  if (sha === "head") return options.recursive
    ? { truncated: true, tree: [] }
    : { truncated: false, tree: Array.from({ length: pages }, (_, i) => ({ path: `folder${i}`, type: "tree", sha: String(i) })) };
  return { truncated: false, tree: Array.from({ length: pageSize }, (_, i) => ({
    path: `file${i}.txt`, type: "blob", sha: "a".repeat(40), size: i,
  })) };
};
(async () => {
  let count = 0, bytes = 0;
  const files = source.iterateFiles ? source.iterateFiles() : await source.getFiles();
  for await (const file of files) {
    assert.equal(file.repoId, "heap-fixture");
    if (file.size !== undefined) { bytes += file.size; assert.ok(file.path.startsWith("folder")); }
    count++;
  }
  assert.equal(count, pages * (pageSize + 1));
  assert.equal(bytes, pages * pageSize * (pageSize - 1) / 2);
  console.log(JSON.stringify({ count, bytes, peakRssMiB: process.resourceUsage().maxRSS / 1024 }));
})().catch(error => { console.error(error); process.exitCode = 1; });
