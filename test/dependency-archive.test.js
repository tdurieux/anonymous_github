const { expect } = require("chai");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const archiver = require("archiver");
const { Parse } = require("unzip-stream");

describe("archive glob dependency compatibility", function () {
  it("archives nested matches and excludes ignored files with the patched matcher", async function () {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "archive-dependencies-"));
    const archive = archiver("zip");
    const parser = Parse();
    try {
      await fs.mkdir(path.join(directory, "nested"));
      await Promise.all(["README.md", "nested/notes.md", "nested/private.md", "nested/code.js"]
        .map(name => fs.writeFile(path.join(directory, name), name)));
      // archiver-utils uses glob.sync, while archiver.glob uses readdir-glob
      // and Minimatch. Exercise both callers of the major-version overrides.
      expect(require("archiver-utils").file.expand({ cwd: directory }, ["**/*.md", "!**/private.md"]).sort())
        .to.deep.equal(["README.md", "nested/notes.md"]);
      const entries = [];
      const reads = [];
      parser.on("entry", entry => {
        const chunks = [];
        entry.on("data", chunk => chunks.push(chunk));
        reads.push(once(entry, "end").then(() => entries.push({ name: entry.path, body: Buffer.concat(chunks).toString() })));
      });
      const finished = once(parser, "finish");
      archive.pipe(parser);
      archive.glob("**/*.md", { cwd: directory, ignore: ["**/private.md"] });
      await archive.finalize();
      await finished;
      await Promise.all(reads);
      expect(entries.sort((a, b) => a.name.localeCompare(b.name)))
        .to.deep.equal(["nested/notes.md", "README.md"].map(name => ({ name, body: name })));
    } finally {
      archive.destroy();
      parser.destroy();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
