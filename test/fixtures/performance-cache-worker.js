const process = require("node:process");
const { Readable } = require("node:stream");
const { setTimeout: delay } = require("node:timers/promises");
require("ts-node/register/transpile-only");
const GitHubStream = require("../../src/core/source/GitHubStream").default;
const source = new GitHubStream({ repoId: "replicas", organization: "owner", repoName: "repo", commit: "commit",
  cacheGeneration: process.env.TEST_GENERATION || "generation1", getToken: () => "token" });
source.downloadWithFallback = async () => {
  process.send({ producer: true });
  return Readable.from((async function* () {
    yield Buffer.from("complete "); await delay(200); yield Buffer.from("content");
  })());
};
process.once("message", async () => {
  try {
    const contents = await Promise.all(Array.from({ length: 5 }, async () => {
      const input = await source.getFileContentCache("file.txt", "replicas", () => ({ sha: "blob", size: 16 }));
      let text = ""; for await (const chunk of input) text += chunk; return text;
    }));
    process.send({ contents }); process.exit(0);
  } catch (error) { process.send({ error: error.message }); process.exit(1); }
});
process.send({ ready: true });
