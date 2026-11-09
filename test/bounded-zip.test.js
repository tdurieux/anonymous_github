const { expect } = require("chai");
const { setImmediate, setTimeout } = require("timers");
const { once } = require("events");
const { Writable } = require("stream");
const archiver = require("archiver");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
require("ts-node/register/transpile-only");
const { boundedZip } = require("../src/core/bounded-zip");

async function bytes(archive, entries) {
  const chunks = [];
  archive.on("data", chunk => chunks.push(chunk));
  const end = once(archive, "end");
  for (const entry of entries) archive.append(entry.body, { date: new Date("2020-01-01T00:00:00Z"), ...entry.options });
  await archive.finalize(); await end;
  return Buffer.concat(chunks);
}

describe("bounded ZIP central directory", function () {
  this.timeout(20000);
  it("preserves archive bytes, compression, Unicode names, modes, and empty files", async () => {
    const entries = [
      { body: "private text\n".repeat(100), options: { name: "folder/é中.txt", mode: 0o100755 } },
      { body: Buffer.from([0, 1, 255]), options: { name: "binary.dat", store: true } },
      { body: "", options: { name: "empty.txt" } },
    ];
    expect(await bytes(boundedZip(), entries)).to.deep.equal(await bytes(archiver("zip"), entries));
    expect(await bytes(boundedZip(), [])).to.deep.equal(await bytes(archiver("zip"), []));
  });

  it("preserves ZIP64 size and offset encoding beyond 4 GiB", async () => {
    const Entry = require("compress-commons/lib/archivers/zip/zip-archive-entry");
    async function directory(archive) {
      const entry = new Entry("large.bin");
      entry.setMethod(0); entry.setTime(new Date("2020-01-01"));
      entry.setSize(2 ** 32 + 123); entry.setCompressedSize(2 ** 32 + 123);
      entry._offsets = { file: 2 ** 32 + 456 };
      archive._module.engine._entries.push(entry);
      archive._module.engine.offset = 2 ** 33;
      return bytes(archive, []);
    }
    expect(await directory(boundedZip())).to.deep.equal(await directory(archiver("zip")));
  });

  it("preserves ZIP64 counts and drains 180,636 records under a 128 MiB heap", function () {
    this.timeout(60000);
    const output = execFileSync(process.execPath, ["--max-old-space-size=128", "test/fixtures/zip-directory-memory.js"],
      { cwd: process.cwd(), timeout: 55000, encoding: "utf8" });
    const result = JSON.parse(output.trim().split("\n").pop());
    expect(result.entries).to.equal(180636);
    expect(result.zip64Count).to.equal(180636);
    expect(result.centralRecords).to.equal(180636);
    expect(result.heapMiB).to.be.lessThan(128);
  });

  it("reports spool write failures through the stream error handler", () => {
    const archive = boundedZip();
    let failure;
    archive.on("error", error => { failure = error; });
    const Entry = require("compress-commons/lib/archivers/zip/zip-archive-entry");
    const entry = new Entry("file.txt"); entry.setMethod(0); entry.setTime(new Date()); entry._offsets = { file: 0 };
    const write = fs.writeSync;
    try {
      fs.writeSync = () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
      expect(() => archive._module.engine._entries.push(entry)).not.to.throw();
      expect(failure?.code).to.equal("ENOSPC");
    } finally { fs.writeSync = write; archive.abort(); }
  });

  it("removes its spool when aborted while waiting for a slow consumer", async () => {
    const existing = new Set(fs.readdirSync(os.tmpdir()));
    const archive = boundedZip();
    archive.on("error", () => {});
    const sink = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) {} });
    archive.pipe(sink);
    archive.append("small file", { name: "test.txt" });
    await once(archive, "entry");
    const created = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("anonymous-zip-directory-") && !existing.has(n));
    expect(created).to.have.length(1);
    const engine = archive._module.engine;
    const Entry = require("compress-commons/lib/archivers/zip/zip-archive-entry");
    for (let i = 0; i < 50000; i++) {
      const entry = new Entry(`${"directory/".repeat(32)}file-${i}.txt`); entry.setMethod(0); entry.setTime(new Date()); entry._offsets = { file: 0 };
      engine._entries.push(entry);
    }
    try {
      void archive.finalize().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(engine._archive.finished).to.equal(false);
    } finally { archive.abort(); sink.destroy(); }
    await new Promise(resolve => setImmediate(resolve));
    expect(fs.existsSync(`${os.tmpdir()}/${created[0]}`)).to.equal(false);
  });
});
