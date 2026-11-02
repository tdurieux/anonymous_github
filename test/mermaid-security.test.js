const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const read = file => fs.readFileSync(path.join(__dirname, "../public", file), "utf8");
const loader = [...read("index.html").matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes("window.loadMermaid"));

describe("Mermaid untrusted diagram security", function () {
  this.timeout(10000);
  let dom, window;
  beforeEach(function () {
    dom = new JSDOM("<body></body>", { runScripts: "outside-only", url: "https://viewer.test/" });
    window = dom.window;
    window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 100, height: 20 });
    vm.runInContext(read("script/external/mermaid.min.js"), dom.getInternalVMContext());
  });
  afterEach(function () { dom.window.close(); });

  it("lazy-loads with strict security and rejects diagram overrides and click links", async function () {
    window.eval(loader);
    window.loadMermaid();
    window.document.querySelector("script").onload();
    expect(window.mermaidInitialized).to.equal(true);
    expect(window.mermaid.mermaidAPI.getConfig().securityLevel).to.equal("strict");
    const result = await window.mermaid.render("hostile-diagram", `%%{init: {"securityLevel": "loose"}}%%
flowchart TD
  A[Readme] --> B[Details]
  click A href "javascript:alert(document.domain)" "Open"
  click B call alert() "Callback"`);
    expect(result.svg).to.include("Readme");
    expect(result.svg).not.to.include("javascript:");
    window.document.body.innerHTML = result.svg;
    let callbacks = 0;
    window.alert = () => { callbacks++; };
    result.bindFunctions?.(window.document.body);
    expect(window.document.querySelector("a[href], a[xlink\\:href]")).to.equal(null);
    window.document.querySelectorAll(".node").forEach(node => {
      node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(callbacks).to.equal(0);
    expect(window.mermaid.mermaidAPI.getConfig().securityLevel).to.equal("strict");
  });

  it("initializes strict security through the extension fallback too", function () {
    const scheduled = [];
    window.setTimeout = callback => scheduled.push(callback);
    window.eval(read("script/external/marked-mermaid.js"));
    const extension = window.markedMermaid().extensions[0];
    extension.renderer({ text: "graph TD; A-->B" });
    scheduled.forEach(callback => callback());
    expect(window.mermaidInitialized).to.equal(true);
    expect(window.mermaid.mermaidAPI.getConfig().securityLevel).to.equal("strict");
  });
});
