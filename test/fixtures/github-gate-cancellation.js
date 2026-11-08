const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { setImmediate: nextTurn, setTimeout: delay } = require("node:timers/promises");
const { setTimeout, clearTimeout } = require("node:timers");
const redis = require("redis");
let reads = 0;
const resetAt = Date.now() + 10 * 60 * 1000;
let readGate = async () => String(resetAt);
const client = { isOpen: true, on() { return this; }, async connect() {},
  async get() { reads++; return readGate(); }, destroy() { this.isOpen = false; } };
redis.createClient = () => client;
require("ts-node/register/transpile-only");
const github = require("../../src/core/GitHubUtils");
const GitHubStream = require("../../src/core/source/GitHubStream").default;
const got = require("got");

async function main() {
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(github.waitForTokenGate("token", preAborted.signal), { name: "AbortError" });
  assert.equal(reads, 0);

  const firstController = new AbortController(), secondController = new AbortController();
  const first = github.waitForTokenGate("token", firstController.signal);
  let secondSettled = false;
  const second = github.waitForTokenGate("token", secondController.signal).finally(() => { secondSettled = true; });
  await nextTurn(); firstController.abort();
  await assert.rejects(first, { name: "AbortError" });
  await delay(20); assert.equal(secondSettled, false);
  secondController.abort(); await assert.rejects(second, { name: "AbortError" });

  // A shared Redis lookup may remain pending. Cancelling one caller must
  // release that caller without closing the shared client.
  readGate = () => new Promise(() => {});
  const lookupController = new AbortController();
  const lookup = github.waitForTokenGate("token", lookupController.signal);
  await nextTurn(); lookupController.abort();
  await assert.rejects(lookup, { name: "AbortError" }); assert.equal(client.isOpen, true);

  let entered;
  const gateEntered = new Promise(resolve => { entered = resolve; });
  readGate = async () => { entered(); return String(resetAt); };
  let metadataCalls = 0;
  github.octokit = () => ({ repos: { getContent: async () => { metadataCalls++; throw Error("unexpected metadata request"); } } });
  got.stream = () => new Readable({ read() {
    this.destroy(Object.assign(Error("private web 404"), { response: { statusCode: 404 } }));
  } });
  const source = new GitHubStream({ repoId: "gate-cancel", organization: "owner", repoName: "repo", commit: "pinned", getToken: () => "token" });
  const input = source.deferredRawDownload("token", "file.bin");
  const collected = (async () => { for await (const chunk of input) void chunk; })().catch(() => {});
  await gateEntered; await nextTurn();
  const closed = new Promise(resolve => input.once("close", resolve)); input.destroy();
  await closed; await collected;
  assert.equal(metadataCalls, 0); assert.equal(input.closed, true);
}

const watchdog = setTimeout(() => { console.error("Cancellation did not release the gate wait"); process.exit(1); }, 5000);
watchdog.unref();
main().then(() => { clearTimeout(watchdog); console.log("gate cancellations released"); },
  error => { clearTimeout(watchdog); console.error(error); process.exit(1); });
// Do not force a successful exit: any retained ten-minute timer must fail
// the parent test's process timeout.
