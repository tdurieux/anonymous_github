const { expect } = require("chai");
const { fork } = require("node:child_process");
const { promises: fs } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { randomBytes } = require("node:crypto");
const { once } = require("node:events");
const { setTimeout } = require("node:timers");
const { fetch } = globalThis;
const mongoose = require("mongoose");
require("ts-node/register/transpile-only");
const db = require("../src/server/database");
const Repo = require("../src/core/model/anonymizedRepositories/anonymizedRepositories.model").default;
const Repository = require("../src/core/Repository").default;
const config = require("../src/config").default;
const uri = process.env.PERFORMANCE_MONGO_URI;

(uri ? describe : describe.skip)("production streamer lifecycle and idle cleanup", function () {
  this.timeout(30000);
  let root, previousFolder;
  before(async () => {
    if (!/\/perf_test_[A-Za-z0-9_-]+(?:\?|$)/.test(uri)) throw Error("An isolated perf_test_ database is required");
    await mongoose.connect(uri); db.isConnected = true;
    root = await fs.mkdtemp(path.join(tmpdir(), "streamer-lifecycle-"));
    previousFolder = config.FOLDER; config.FOLDER = path.join(root, "repositories");
  });
  after(async () => {
    db.isConnected = false; await mongoose.connection.dropDatabase(); await mongoose.disconnect();
    config.FOLDER = previousFolder; await fs.rm(root, { force: true, recursive: true });
  });
  beforeEach(async () => { await Repo.deleteMany({}); });

  const missing = async file => { try { await fs.access(file); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; } };
  async function waitFor(check, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!await check()) { if (Date.now() >= deadline) throw Error("Streamer cleanup did not finish"); await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  async function launch(invalidCredentials = false, holdConnect = false) {
    const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const directory = await fs.mkdtemp(path.join(root, "streamer-temp-"));
    const stale = path.join(directory, "anonymous-text-crashed"); await fs.mkdir(stale);
    await fs.writeFile(path.join(stale, "input"), "original private bytes"); await fs.utimes(stale, new Date(0), new Date(0));
    const child = fork(path.join(__dirname, "fixtures/performance-streamer.js"), [], {
      execArgv: ["--max-old-space-size=512"], stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, NODE_ENV: "test", PORT: String(port), MONGODB_URI: uri, GITHUB_APP_ENABLED: "false", STORAGE: "filesystem",
        PERFORMANCE_HOLD_CONNECT: holdConnect ? "1" : "0",
        REDIS_HOSTNAME: "127.0.0.1", REDIS_PORT: process.env.PERFORMANCE_REDIS_PORT || "6379", TMPDIR: directory, FOLDER: config.FOLDER,
        CREDENTIAL_KEYS: invalidCredentials ? "invalid" : JSON.stringify({ test: randomBytes(32).toString("base64") }), CREDENTIAL_ACTIVE_KEY_ID: "test" },
    });
    const messages = []; child.on("message", message => messages.push(message));
    const ready = new Promise((resolve, reject) => {
      let logs = "";
      child.stdout.on("data", chunk => { logs += chunk; if (logs.includes("streamer started")) resolve(); });
      child.stderr.on("data", () => {});
      child.once("error", reject); child.once("exit", code => reject(Error(`Streamer exited ${code} before serving`)));
    });
    ready.catch(() => {});
    return { child, ready, messages, directory, stale, url: `http://127.0.0.1:${port}` };
  }
  async function stop(runtime) {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
      const exited = once(runtime.child, "exit"); runtime.child.kill(); await exited;
    }
    await fs.rm(runtime.directory, { force: true, recursive: true });
  }
  async function createRow(repoId) {
    return Repo.create({ repoId, status: "ready", statusDate: new Date(), lastView: new Date(), anonymizeDate: new Date(), treeGeneration: "active",
      source: { type: "GitHubStream", repositoryName: "owner/repo", commit: "abc" }, options: { terms: ["NeverMatches"], expirationMode: "remove", expirationDate: new Date(0) } });
  }
  async function request(runtime, row, filePath, legacy = false) {
    const options = new Repository(row).generateAnonymizeTransformer(filePath).opt;
    return fetch(runtime.url + "/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "test-token",
      repoId: row.repoId, repoFullName: "owner/repo", commit: "abc", ...(legacy ? {} : { cacheGeneration: options.cacheGeneration }), sha: "blob", size: 300000, filePath, anonymizerOptions: options }) });
  }

  for (const [filePath, expectedStatus] of [["fail-401.txt", 401], ["fail-reset.txt", 502]]) {
    it(`contains ${filePath} errors in the actual streamer and serves another request`, async () => {
      const runtime = await launch();
      try {
        await runtime.ready;
        const row = await createRow(filePath);
        const failure = await request(runtime, row, filePath);
        expect(failure.status).to.equal(expectedStatus); await failure.text();
        expect((await fetch(runtime.url + "/healthcheck")).status).to.equal(200);
        const recovered = await request(runtime, row, "working.txt");
        expect(recovered.status).to.equal(200); expect((await recovered.text()).length).to.equal(300000);
        expect(runtime.child.exitCode).to.equal(null);
      } finally { await stop(runtime); }
    });
  }

  it("connects before serving and rejects a fill published after expiration in the actual streamer entrypoint", async () => {
    const runtime = await launch(false, true); let pending;
    try {
      // Loading TypeScript and the Redis client in a fresh process can take
      // longer than the cleanup deadline used after the streamer starts.
      await waitFor(() => runtime.messages.some(message => message.connectionHeld), 10000);
      await fetch(runtime.url + "/healthcheck").then(() => { throw Error("Streamer served before connecting"); }, error => expect(error).to.be.instanceOf(Error));
      runtime.child.send("connect");
      await runtime.ready;
      expect(await (await fetch(runtime.url + "/healthcheck")).json()).to.deep.equal({ status: "ok" });
      runtime.child.send("inspect"); await waitFor(() => runtime.messages.some(message => message.connected !== undefined));
      expect(runtime.messages.find(message => message.connected !== undefined)).to.deep.equal({ connected: true, maxPoolSize: 10, minPoolSize: 0 });
      expect(await missing(runtime.stale)).to.equal(true);
      const row = await createRow("streamer-late-fill");
      pending = request(runtime, row, "hold.txt"); pending.catch(() => {});
      await waitFor(() => runtime.messages.some(message => message.held));
      await new Repository(await Repo.findById(row._id)).expire();
      runtime.child.send("release");
      const response = await pending; expect(response.status).to.equal(409); expect((await response.json()).error).to.equal("repository_changed");
      const sourceRoot = path.join(config.FOLDER, row.repoId, "original");
      const entries = await fs.readdir(sourceRoot, { recursive: true });
      expect(entries.filter(name => name.endsWith("hold.txt"))).to.deep.equal([]);
      const rejected = await request(runtime, row, "rejected.txt"); expect(rejected.status).to.equal(409); await rejected.text();
      const legacy = await request(runtime, row, "legacy.txt", true); expect(legacy.status).to.equal(409); await legacy.text();
      expect(runtime.messages.filter(message => message.download)).to.have.length(1);
    } finally { runtime.child.send("release"); await pending?.catch(() => {}); await stop(runtime); }
  });

  it("purges another process's transformed cache and crash spools while idle after lifecycle changes", async () => {
    const runtime = await launch();
    try {
      await runtime.ready;
      const row = await createRow("streamer-cache"); const response = await request(runtime, row, "file.txt");
      expect(response.status).to.equal(200); expect((await response.text()).length).to.equal(300000);
      const cacheRoot = path.join(runtime.directory, "anonymous-transformed-v1");
      expect((await fs.readdir(cacheRoot)).filter(name => name.endsWith(".data"))).to.have.length(1);
      const recent = path.join(runtime.directory, "anonymous-text-idle-crash");
      await fs.mkdir(recent); await fs.writeFile(path.join(recent, "input"), "private original"); await fs.utimes(recent, new Date(0), new Date(0));
      await new Repository(await Repo.findById(row._id)).expire();
      await waitFor(async () => (await fs.readdir(cacheRoot)).length === 0 && await missing(recent));
      expect(runtime.messages.filter(message => message.download)).to.have.length(1);
    } finally { await stop(runtime); }
  });

  it("refuses to serve when required startup configuration is invalid", async () => {
    const runtime = await launch(true);
    try {
      const [code] = await once(runtime.child, "exit"); expect(code).to.equal(1);
      await fetch(runtime.url + "/healthcheck").then(() => { throw Error("Streamer served before connecting"); }, error => expect(error).to.be.instanceOf(Error));
    } finally { await stop(runtime); }
  });
});
