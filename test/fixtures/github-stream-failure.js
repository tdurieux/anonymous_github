const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { setImmediate } = require("node:timers");
require("ts-node/register/transpile-only");
const GitHubStream = require("../../src/core/source/GitHubStream").default;
const failure = Object.assign(new Error("upstream failed"), process.argv[2] === "reset" ? { code: "ECONNRESET" } : { response: { statusCode: 401 } });
const source = new GitHubStream({ repoId: "fixture", organization: "owner", repoName: "repo", commit: "abc", getToken: () => "token" });
async function main() {
  if (process.argv[2] === "fatal") {
    require("../../src/core/process-monitoring").installFatalErrorLogging("streamer");
    await new Promise(() => setImmediate(() => { throw new Error("fixture fatal"); }));
  }
  if (process.argv[2] === "fallback" || process.argv[2] === "public-raw") {
    source.downloadFile = () => {
      const input = new Readable({ read() {} });
      process.nextTick(() => input.destroy(Object.assign(new Error("blob unavailable"), { response: { statusCode: 404 } })));
      return input;
    };
    source.downloadFileViaRaw = () => {
      const input = new Readable({ read() {} });
      process.nextTick(() => input.destroy(failure));
      return input;
    };
    const content = await source.downloadWithFallback(process.argv[2] === "public-raw" ? "" : "token", "blob", "file");
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(async () => { for await (const chunk of content) void chunk; }, error => error === failure);
  } else if (process.argv[2] === "lfs") {
    const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 10\n";
    source.downloadFileViaRaw = () => new Readable({ read() { this.destroy(failure); } });
    const content = source.resolveLfsPointer(Readable.from([pointer]), "token", "file");
    // A producer must not start emitting errors while its consumer is still awaiting.
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(async () => { for await (const chunk of content) void chunk; }, error => error === failure);
  } else {
    source.downloadFile = () => {
      const content = new Readable({ read() {} });
      process.nextTick(() => content.destroy(failure));
      return content;
    };
    await assert.rejects(source.downloadWithFallback("token", "blob", "file"), error => error === failure);
    await new Promise(resolve => setImmediate(resolve));
  }
}
main().then(() => { process.stdout.write("failure contained\n"); process.exit(0); }, error => { console.error(error); process.exit(1); });
