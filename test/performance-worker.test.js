const { expect } = require("chai");
const { Readable } = require("node:stream");
const { promises: fs } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
require("ts-node/register/transpile-only");
const { ContentAnonimizer, AnonymizeTransformer } = require("../src/core/anonymize-utils");
const pool = require("../src/core/anonymization-pool");
const { removeStaleTextSpools } = require("../src/core/temporary-storage");
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
    const client = { isOpen: true, disconnect: async () => { disconnected = true; } };
    try { await cacheCommand(new Promise(() => {}), client, 20); } catch (failure) { error = failure; }
    expect(error.message).to.equal("cache_command_timeout"); expect(disconnected).to.equal(true);
  });
});
