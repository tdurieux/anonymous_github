const normalizeFootnotes = html => html.replace(/footnote-(?:[a-f0-9]+-){4}/g, "footnote-");
const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
require("ts-node/register/transpile-only");
const { renderMarkdown } = require("../src/markdown");
const { renderDiagram } = require("../src/markdown-diagrams");
const root = path.resolve(__dirname, "..");

function checkHtml(html, allowMediaData = false) {
  const dom = JSDOM.fragment(html);
  expect(dom.querySelector("script,iframe,object,embed,form,base,meta,link")).to.equal(null);
  for (const element of dom.querySelectorAll("*")) {
    for (const attr of element.attributes) {
      expect(attr.name).not.to.match(/^on/i);
      if (["href", "xlink:href", "src", "srcset", "poster"].includes(attr.name)) {
        // Strip URL control characters before checking executable schemes.
        // eslint-disable-next-line no-control-regex
        expect(attr.value.replace(/[\u0000-\u0020]/g, "")).not.to.match(allowMediaData && ["src", "srcset", "poster"].includes(attr.name) ? /(?:javascript|vbscript):/i : /(?:javascript|vbscript|data):/i);
      }
    }
  }
}

describe("Markdown security boundaries", function () {
  const attacks = [
    '<img src=x onerror="alert(1)"><svg><script>alert(1)</script></svg>',
    '<a href="java&#x09;script:alert(1)">link</a><video poster="javascript:alert(1)"><source src="data:text/html,attack"></video>',
    '<picture><source srcset="javascript:alert(1) 1x, https://safe.test/x 2x"><img src="data:image/svg+xml,<svg onload=alert(1)>"></picture>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
    '<svg><foreignObject><p><style><img src=x onerror=alert(1)></style></p></foreignObject></svg>',
    '<details open ontoggle="alert(1)"><summary onclick="alert(1)">More</summary></details>',
    '<input type="image" src="javascript:alert(1)" formaction="https://evil.test" autofocus onfocus="alert(1)">',
    'Text[^a" onclick="alert(1)]\n\n[^a" onclick="alert(1)]: Note',
    '$\\href{javascript:alert(1)}{click}$',
    '$\\url{javascript:alert(1)}$',
    '$\\includegraphics{https://evil.test/tracker.svg}$',
    '$\\htmlData{evil=1 onmouseover=alert(1)}{x}$',
    '$\\htmlStyle{background:url(https://evil.test/tracker)}{x}$',
    '<span data-render-token="fake-0"></span><svg onload="alert(1)"></svg>',
    '```javascript\n</code><img src=x onerror=alert(1)>\n```',
    '```mermaid\ngraph TD; A["</pre><img src=x onerror=alert(1)>"]\n```',
  ];
  let browser;
  before(function () {
    browser = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", url: "https://viewer.test/" });
    vm.runInContext(fs.readFileSync(path.join(root, "public/script/markdown.min.js"), "utf8"), browser.getInternalVMContext());
  });
  after(function () { browser.window.close(); });
  for (const [index, source] of attacks.entries()) it(`rejects active content payload ${index + 1} on server and browser`, function () {
    const server = renderMarkdown(source);
    const client = browser.window.MarkdownRenderer.render(source);
    checkHtml(server); checkHtml(client);
    expect(normalizeFootnotes(client)).to.equal(normalizeFootnotes(server));
  });

  it("sanitizes mutation payloads with the shipped DOMPurify", function () {
    const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
    try {
      vm.runInContext(fs.readFileSync(path.join(root, "public/script/external/purify.min.js"), "utf8"), dom.getInternalVMContext());
      for (const source of attacks.slice(0, 7)) checkHtml(dom.window.DOMPurify.sanitize(source), true);
    } finally { dom.window.close(); }
  });

  it("enforces strict Mermaid mode even when source HTML supplies an initialization flag", async function () {
    const dom = new JSDOM('<!doctype html><body><a id="mermaidInitialized"></a><pre class="mermaid">graph TD; A-->B</pre></body>', { runScripts: "outside-only" });
    let configuration;
    try {
      dom.window.mermaid = {
        initialize(value) { configuration = value; },
        async run({ nodes }) { nodes.forEach(node => { node.dataset.processed = "true"; }); },
      };
      vm.runInContext(fs.readFileSync(path.join(root, "public/script/markdown.min.js"), "utf8"), dom.getInternalVMContext());
      await new Promise(resolve => require("node:timers").setTimeout(resolve, 0));
      expect(configuration.securityLevel).to.equal("strict");
    } finally { dom.window.close(); }
  });

  for (const [library, source, publicFile] of [
    ["Mermaid", "node_modules/mermaid/dist/mermaid.min.js", "public/script/external/mermaid.min.js"],
    ["DOMPurify", "node_modules/dompurify/dist/purify.min.js", "public/script/external/purify.min.js"],
    ["KaTeX", "node_modules/katex/dist/katex.min.js", "public/script/external/katex.min.js"],
    ["KaTeX CSS", "node_modules/katex/dist/katex.min.css", "public/css/katex.min.css"],
  ]) it(`ships the audited ${library} version without an outdated vendored copy`, function () {
    expect(fs.readFileSync(path.join(root, publicFile)).equals(fs.readFileSync(path.join(root, source)))).to.equal(true);
  });

  it("rejects array-like objects before TopoJSON loops over their forged length", function () {
    const topology = { type: "Topology", arcs: [{ 0: [0, 0], length: 1e12 }], objects: { line: { type: "LineString", arcs: [0] } } };
    expect(() => renderDiagram(JSON.stringify(topology), "topojson")).to.throw("array");
  });
  it("bounds repeated TopoJSON arc expansion before allocating coordinates", function () {
    const topology = { type: "Topology", arcs: [Array.from({ length: 1000 }, (_, i) => [i / 100, 0])], objects: { line: { type: "LineString", arcs: Array(1000).fill(0) } } };
    expect(() => renderDiagram(JSON.stringify(topology), "topojson")).to.throw("expansion limit");
  });
  it("rejects deeply nested geometry before recursive library calls", function () {
    let geometry = { type: "Point", coordinates: [0, 0] };
    for (let i = 0; i < 40; i++) geometry = { type: "GeometryCollection", geometries: [geometry] };
    expect(() => renderDiagram(JSON.stringify(geometry), "geojson")).to.throw("complexity limit");
  });
  it("rejects nonnumeric coordinate objects without invoking D3", function () {
    expect(() => renderDiagram('{"type":"Point","coordinates":[{"valueOf":"attack"},0]}', "geojson")).to.throw("position");
  });
  it("bounds diagram input size and keeps rejected source readable", function () {
    expect(() => renderDiagram(" ".repeat(1_000_001), "stl")).to.throw("source limit");
    const source = '```geojson\n{"type":"Point","coordinates":[null,0]}\n```';
    expect(JSDOM.fragment(renderMarkdown(source)).querySelector("pre code").textContent).to.include('"coordinates":[null,0]');
  });
});
