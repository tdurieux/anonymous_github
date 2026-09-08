const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const process = require("node:process");

const gulpfile = path.resolve(__dirname, "../gulpfile.js");
const source = fs.readFileSync(gulpfile, "utf8");
const groups = Object.fromEntries(
  [...source.matchAll(/const (\w+Files) = \[([\s\S]*?)\];/g)].map(match => [
    match[1], [...match[2].matchAll(/"([^"]+)"/g)].map(file => file[1]),
  ])
);

describe("asset build", function () {
  this.timeout(15000);
  let directory;

  beforeEach(function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "anonymous-assets-"));
    for (const file of Object.values(groups).flat()) {
      const target = path.join(directory, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.endsWith(".css")
        ? `.cascade { color: ${file.endsWith("/style.css") ? "red" : "blue"}; }`
        : `globalThis.assetOrder.push(${JSON.stringify(file)});`);
    }
  });

  afterEach(function () {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function build() {
    return spawnSync(process.execPath, [
      "-e",
      `require(${JSON.stringify(gulpfile)}).default(error => {
        if (error) { console.error(error); process.exitCode = 1; }
      });`,
    ], { cwd: directory, encoding: "utf8", timeout: 10000 });
  }

  it("preserves script dependencies and CSS precedence and hashes completed assets", function () {
    const result = build();
    expect(result.status, result.stderr).to.equal(0);
    for (const [bundle, group] of [["core", "coreJsFiles"], ["vendor", "vendorJsFiles"], ["mermaid", "mermaidFiles"]]) {
      const context = { assetOrder: [] };
      vm.runInNewContext(fs.readFileSync(path.join(directory, `public/script/${bundle}.min.js`), "utf8"), context);
      expect(context.assetOrder).to.deep.equal(groups[group]);
    }
    expect(fs.readFileSync(path.join(directory, "public/css/all.min.css"), "utf8")).to.equal(".cascade{color:#00f}".repeat(groups.cssFiles.length - 1) + ".cascade{color:red}");
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "public/asset-manifest.json"), "utf8"));
    expect(Object.keys(manifest)).to.have.length(4);
    for (const [name, hashed] of Object.entries(manifest)) {
      const content = fs.readFileSync(path.join(directory, "public", name.endsWith(".css") ? "css" : "script", name));
      const hash = require("node:crypto").createHash("md5").update(content).digest("hex").slice(0, 10);
      expect(hashed).to.equal(name.replace(".", `.${hash}.`));
    }
  });

  it("fails on missing input without publishing a manifest", function () {
    fs.unlinkSync(path.join(directory, groups.coreJsFiles[0]));
    const result = build();
    expect(result.status).not.to.equal(0);
    expect(result.stderr).to.include("File not found");
    expect(fs.existsSync(path.join(directory, "public/asset-manifest.json"))).to.equal(false);
  });

  it("fails on invalid JavaScript without publishing a manifest", function () {
    fs.writeFileSync(path.join(directory, groups.vendorJsFiles[0]), "function {");
    const result = build();
    expect(result.status).not.to.equal(0);
    expect(result.stderr).to.include("uglify");
    expect(fs.existsSync(path.join(directory, "public/asset-manifest.json"))).to.equal(false);
  });
});
