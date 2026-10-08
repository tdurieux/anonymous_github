const { expect } = require("chai");
const { Readable } = require("node:stream");
const { promises: fs } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { setTimeout } = require("node:timers");
require("ts-node/register/transpile-only");
const { ContentAnonimizer, AnonymizeTransformer } = require("../src/core/anonymize-utils");
const pool = require("../src/core/anonymization-pool");
const { removeStaleTextSpools, startTemporaryStorageMaintenance } = require("../src/core/temporary-storage");
const { cacheCommand } = require("../src/core/cache-coordination");

describe("large anonymization resources", function () {
  this.timeout(20000);
  async function transform(text, options) {
    const bytes = Buffer.from(text), parts = [];
    // Split both a name and a multibyte character at varying chunk boundaries.
    for (let offset = 0; offset < bytes.length; offset += 4093) parts.push(bytes.subarray(offset, offset + 4093));
    const transformer = new AnonymizeTransformer(options), output = [];
    Readable.from(parts).pipe(transformer);
    for await (const chunk of transformer) output.push(chunk);
    return Buffer.concat(output).toString("utf8");
  }
  it("preserves whole-text Unicode matches and isolates cached settings", async () => {
    const text = "Alice Σ 研究 https://example.com/x\n".repeat(18000);
    const options = { filePath: `parity-${randomUUID()}.txt`, terms: ["Alice=>Hidden", "研究=>Other"], image: true, link: true };
    const original = pool.anonymizeOnWorker;
    let jobs = 0;
    pool.anonymizeOnWorker = (...args) => { jobs++; return original(...args); };
    try {
      const expected = new ContentAnonimizer(options).anonymize(text);
      expect(await transform(text, options)).to.equal(expected);
      expect(await transform(text, options)).to.equal(expected);
      expect(jobs).to.equal(1);
      const edited = { ...options, terms: ["Alice=>Changed", "研究=>Other"] };
      expect(await transform(text, edited)).to.equal(new ContentAnonimizer(edited).anonymize(text));
      expect(jobs).to.equal(2);
    } finally { pool.anonymizeOnWorker = original; }
  });
  it("removes a spooled input when its subscriber cancels", async () => {
    const transformer = new AnonymizeTransformer({ filePath: "cancel.txt", terms: ["Alice"] });
    await new Promise((resolve, reject) => transformer.write(Buffer.alloc(300000, "x"), error => error ? reject(error) : resolve()));
    const spool = transformer.spool;
    const closed = new Promise(resolve => transformer.once("close", resolve));
    transformer.destroy(); await closed;
    let exists = true;
    try { await fs.access(spool); } catch { exists = false; }
    expect(exists).to.equal(false);
  });
  it("recovers worker capacity after a failed input", async () => {
    const controller = new AbortController();
    let failure;
    try { await pool.anonymizeOnWorker({ input: join(tmpdir(), randomUUID()), output: join(tmpdir(), randomUUID()),
      options: { terms: ["Alice"] }, maxOutput: 1000000, context: { mask: "ANON", hostname: "localhost" } }, 1, controller.signal); }
    catch (error) { failure = error; }
    expect(failure).to.be.instanceOf(Error);
    const text = "Alice ".repeat(50000);
    const options = { filePath: `recovery-${randomUUID()}.txt`, terms: ["Alice=>Hidden"] };
    expect(await transform(text, options)).to.equal(new ContentAnonimizer(options).anonymize(text));
  });
  it("finishes large files containing many safe regex rules", async () => {
    const payload = "123,456,78.91234,-45.123456\n".repeat(280000);
    const terms = ["Alice", ...Array.from({ length: 8 }, (_, i) => `Researcher${i}[0-9]+`)];
    const output = await transform(`Alice\n${payload}Alice`, {
      filePath: `safe-regex-${randomUUID()}.csv`, terms,
    });
    expect(output).to.equal(`XXXX-1\n${payload}XXXX-1`);
  });

  it("uses the worker budget for dense Unicode replacements", async () => {
    const input = "Álice,123,45.678,-23.456\n".repeat(800000);
    expect(await transform(input, { filePath: `dense-unicode-${randomUUID()}.csv`, terms: ["Alice"] }))
      .to.equal("XXXX-1,123,45.678,-23.456\n".repeat(800000));
  });

  it("retains the short deadline for backtracking regexes on a worker and recovers", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "worker-regex-deadline-"));
    const input = join(root, "input"), output = join(root, "output");
    const controller = new AbortController();
    try {
      const text = "a".repeat(250);
      await fs.writeFile(input, text);
      let failure;
      const started = Date.now();
      try {
        await pool.anonymizeOnWorker({ input, output, options: { terms: ["a+a+a+a+a+a+b(?=x)"] },
          maxOutput: 1000000, context: { mask: "XXXX", hostname: "localhost" } }, text.length, controller.signal);
      } catch (error) { failure = error; }
      expect(failure).to.be.instanceOf(Error);
      expect(failure.message).to.match(/timed out after 1000ms/);
      expect(Date.now() - started).to.be.lessThan(8000);
      let exists = true;
      try { await fs.access(output); } catch (error) { if (error.code === "ENOENT") exists = false; else throw error; }
      expect(exists).to.equal(false);
      expect(await transform("Alice ".repeat(50000), { filePath: `regex-recovery-${randomUUID()}.txt`, terms: ["Alice"] }))
        .to.equal("XXXX-1 ".repeat(50000));
    } finally { controller.abort(); await fs.rm(root, { force: true, recursive: true }); }
  });
  it("cleans crash leftovers while preserving recent spools and unrelated files", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "anonymous-spool-test-"));
    try {
      const old = join(root, "anonymous-text-old"), current = join(root, "anonymous-text-current"), other = join(root, "other");
      await Promise.all([old, current, other].map(path => fs.mkdir(path)));
      await fs.writeFile(join(old, "input"), "private");
      await fs.utimes(old, new Date(0), new Date(0));
      await removeStaleTextSpools(root);
      expect((await fs.readdir(root)).sort()).to.deep.equal(["anonymous-text-current", "other"]);
    } finally { await fs.rm(root, { force: true, recursive: true }); }
  });
  it("bounds an unresponsive Redis command and disconnects its socket", async () => {
    let disconnected = false, error;
    const client = { isOpen: true, destroy: () => { disconnected = true; } };
    try { await cacheCommand(new Promise(() => {}), client, 20); } catch (failure) { error = failure; }
    expect(error.message).to.equal("cache_command_timeout"); expect(disconnected).to.equal(true);
  });

  it("cleans stale spools and transformed entries at startup and while idle", async () => {
    const cacheRoot = join(tmpdir(), "anonymous-transformed-v1");
    const stale = await fs.mkdtemp(join(tmpdir(), "anonymous-text-startup-"));
    const recent = await fs.mkdtemp(join(tmpdir(), "anonymous-text-idle-"));
    const unrelated = await fs.mkdtemp(join(tmpdir(), "unrelated-cleanup-"));
    const keys = [randomUUID(), randomUUID(), randomUUID()], paths = keys.flatMap(key => [join(cacheRoot, key + ".json"), join(cacheRoot, key + ".data")]);
    let stop;
    const missing = async path => { try { await fs.access(path); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; } };
    const seed = async (key, version, created) => {
      await fs.writeFile(join(cacheRoot, key + ".data"), "private");
      await fs.writeFile(join(cacheRoot, key + ".json"), JSON.stringify({ version, created, size: 7, changed: false }));
    };
    try {
      await fs.mkdir(cacheRoot, { recursive: true });
      await fs.writeFile(join(stale, "input"), "original bytes"); await fs.utimes(stale, new Date(0), new Date(0));
      await fs.writeFile(join(recent, "input"), "recent original bytes");
      await fs.writeFile(join(unrelated, "input"), "keep");
      await seed(keys[0], 1, Date.now()); await seed(keys[1], 2, 0); await seed(keys[2], 2, Date.now());
      stop = await startTemporaryStorageMaintenance(20);
      expect(await missing(stale)).to.equal(true);
      expect(await missing(join(cacheRoot, keys[0] + ".data"))).to.equal(true);
      expect(await missing(join(cacheRoot, keys[1] + ".data"))).to.equal(true);
      expect(await missing(join(cacheRoot, keys[2] + ".data"))).to.equal(false);
      expect(await missing(recent)).to.equal(false); expect(await missing(unrelated)).to.equal(false);
      await fs.utimes(recent, new Date(0), new Date(0));
      await seed(keys[2], 2, 0);
      const deadline = Date.now() + 2000;
      while ((!await missing(recent) || !await missing(join(cacheRoot, keys[2] + ".data"))) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(await missing(recent)).to.equal(true); expect(await missing(join(cacheRoot, keys[2] + ".json"))).to.equal(true);
      expect(await fs.readFile(join(unrelated, "input"), "utf8")).to.equal("keep");
    } finally {
      stop?.();
      await Promise.all([...paths, stale, recent, unrelated].map(path => fs.rm(path, { force: true, recursive: true })));
    }
  });
});
