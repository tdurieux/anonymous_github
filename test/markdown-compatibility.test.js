const normalizeFootnotes = html => html.replace(/footnote-(?:[a-f0-9]+-){4}/g, "footnote-");
const { expect } = require("chai");
const { JSDOM } = require("jsdom");
const fs = require("node:fs");
const path = require("node:path");
require("ts-node/register/transpile-only");
const { renderMarkdown, sanitizeMarkdownHtml } = require("../src/markdown");
const examples = require("./fixtures/markdown/gfm-extensions.json");
const fragment = source => JSDOM.fragment(renderMarkdown(source));
const stl = "solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle";

function normalize(html) {
  const dom = JSDOM.fragment(html);
  // Formatting whitespace between block elements and boolean-attribute spelling
  // have no semantic effect; keep whitespace inside text and code intact.
  for (const element of dom.querySelectorAll("*")) {
    for (const node of [...element.childNodes]) {
      if (node.nodeType === 3 && element.tagName !== "PRE" && element.tagName !== "CODE") {
        if (/^\s*$/.test(node.textContent) && /^(TABLE|THEAD|TBODY|TR|UL|OL|SECTION|DIV)$/.test(element.tagName)) node.remove();
        else if (node.nextSibling?.nodeName === "UL") node.textContent = node.textContent.trimEnd();
      }
    }
  }
  const container = dom.ownerDocument.createElement("div"); container.append(dom);
  return container.innerHTML.trim();
}

describe("GitHub Markdown compatibility", function () {
  for (const [index, example] of examples.entries()) {
    it(`cmark-gfm ${example.section} example ${index + 1}`, function () {
      if (example.html.trim() === "<IGNORE>") {
        expect(() => renderMarkdown(example.markdown)).not.to.throw();
        return;
      }
      expect(normalize(renderMarkdown(example.markdown))).to.equal(normalize(sanitizeMarkdownHtml(example.html)));
    });
  }

  const cases = [
    ["setext headings", "Title\n=====\n\nSubtitle\n--------", "h1#title + h2#subtitle"],
    ["nested emphasis", "***both*** and ~~deleted~~", "em strong, strong em"],
    ["reference links", "[link][ref]\n\n[ref]: https://example.com \"Title\"", 'a[href="https://example.com"][title="Title"]'],
    ["nested lists", "1. First\n   - Nested\n     - Deep", "ol ul ul li"],
    ["ordered list starts", "42. Forty-two", 'ol[start="42"]'],
    ["hard line breaks", "one  \ntwo\\\nthree", "p br"],
    ["autolink email", "<reader@example.com>", 'a[href="mailto:reader@example.com"]'],
    ["disclosures", "<details open><summary>More</summary>\n\n**Details**\n\n</details>", "details[open] summary"],
    ["keyboard text", "<kbd>Ctrl</kbd> + <kbd>C</kbd>", "kbd"],
    ["subscript and superscript", "H<sub>2</sub>O and x<sup>2</sup>", "sub + sup, sub"],
    ["custom anchors", '<a name="custom"></a>\n\n[Go](#custom)', 'a[name="custom"]'],
    ["picture sources", '<picture><source media="(prefers-color-scheme: dark)" srcset="dark.png"><img src="light.png" alt="Logo"></picture>', 'picture source[media][srcset]'],
    ["aligned HTML", '<p align="center">Centered</p>', 'p[align="center"]'],
    ["theme images", '![Dark](logo.png#gh-dark-mode-only)', 'img.gh-dark-mode-only'],
    ["video links", '[Movie](clip.mp4?download=1)', 'video[controls][src="clip.mp4?download=1"]'],
    ["image dimensions", '<img src="logo.png" width="120" height="80" align="right">', 'img[width="120"][height="80"][align="right"]'],
    ["table spans", '<table><tr><th colspan="2">Heading</th></tr><tr><td rowspan="2">Cell</td></tr></table>', 'th[colspan="2"]'],
    ["emoji", ":smile: :+1: :unknown_emoji:", 'img.emoji[alt=":smile:"]'],
    ["current emoji shortcodes", ":melting_face: :saluting_face: :pink_heart:", 'img.emoji[alt=":melting_face:"]'],
    ["syntax highlighting", "```javascript\nconst answer = 42;\n```", "code.language-javascript .hljs-keyword"],
    ["inline math", "Value $x^2$.", ".katex math msup"],
    ["backtick math", "Value $`x^2`$.", ".katex math msup"],
    ["display math", "$$\nx^2\n$$", ".katex-display math"],
    ["same-line display math", "$$x^2$$", ".katex-display math"],
    ["math fences", "~~~math\nx^2\n~~~", ".katex-display math"],
    ["Mermaid tilde fences", "~~~mermaid\ngraph TD; A-->B\n~~~", "pre.mermaid"],
    ["Mermaid long fences", "````mermaid\ngraph TD; A-->B\n````", "pre.mermaid"],
    ["GeoJSON", '```geojson\n{"type":"LineString","coordinates":[[0,0],[10,10]]}\n```', 'figure[data-diagram="geojson"] svg path'],
    ["TopoJSON", '```topojson\n{"type":"Topology","objects":{"line":{"type":"LineString","arcs":[0]}},"arcs":[[[0,0],[10,10]]]}\n```', 'figure[data-diagram="topojson"] svg path'],
    ["ASCII STL", `\`\`\`stl\n${stl}\n\`\`\``, 'figure[data-diagram="stl"] svg path'],
  ];
  for (const [name, source, selector] of cases) it(`renders ${name}`, function () {
    expect(fragment(source).querySelector(selector), name).not.to.equal(null);
  });
  for (const type of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) it(`renders ${type} alerts`, function () {
    const dom = fragment(`> [!${type}]\n> **Read** this.\n>\n> - Details`);
    const alert = dom.querySelector(`.markdown-alert-${type.toLowerCase()}`);
    expect(alert.querySelector("svg")).not.to.equal(null);
    expect(alert.querySelector("strong").textContent).to.equal("Read");
    expect(alert.querySelector("li").textContent).to.equal("Details");
  });
  it("does not turn nested quotes into alerts", function () {
    expect(fragment("> Outer\n>\n> > [!NOTE]\n> > Nested").querySelector(".markdown-alert")).to.equal(null);
  });
  it("resolves all repeated footnote references and backrefs", function () {
    const dom = fragment("One[^long] and two[^long].\n\n[^long]: First **paragraph**.\n\n    Second paragraph.");
    for (const link of dom.querySelectorAll('a[href^="#"]')) {
      expect(dom.querySelector(`[id="${link.getAttribute("href").slice(1)}"]`), link.outerHTML).not.to.equal(null);
    }
    expect(dom.querySelectorAll("[data-footnote-backref]")).to.have.length(2);
    expect(dom.querySelector(".footnotes").textContent).to.include("Second paragraph.");
  });
  it("keeps footnote navigation and accessibility targets within each document", function () {
    const source = "One[^a].\n\n[^a]: Details";
    const dom = JSDOM.fragment(`<article>${renderMarkdown(source)}</article><article>${renderMarkdown(source)}</article>`);
    const ids = [...dom.querySelectorAll("[id]")].map(node => node.id);
    expect(new Set(ids).size).to.equal(ids.length);
    for (const article of dom.querySelectorAll("article")) {
      for (const node of article.querySelectorAll("[href], [aria-describedby]")) {
        const target = node.getAttribute("aria-describedby") || node.getAttribute("href").slice(1);
        expect(article.querySelector(`[id="${target}"]`)).not.to.equal(null);
      }
    }
  });
  for (const source of ["Costs $5 and $10 per run.", "Budget: $100-$200."]) it(`preserves currency prose: ${source}`, function () {
    const dom = fragment(source);
    expect(dom.querySelector(".katex")).to.equal(null);
    expect(dom.textContent.trim()).to.equal(source);
  });
  it("uses unique GitHub heading slugs including suffixed collisions and Unicode", function () {
    const dom = fragment("# Hello\n# Hello\n# Hello-1\n# Hello\n# 中文 *标题*\n# constructor");
    expect([...dom.querySelectorAll("h1")].map(h => h.id)).to.deep.equal(["hello", "hello-1", "hello-1-1", "hello-2", "中文-标题", "constructor"]);
  });
  it("keeps formatting syntax literal inside code and escaped text", function () {
    const dom = fragment("`$x$ :smile: [^a]`\n\n```text\n> [!NOTE]\n$x$ :smile:\n```\n\n\\*literal\\* and \\$5");
    expect(dom.querySelector(".katex, .emoji, .markdown-alert")).to.equal(null);
    expect(dom.textContent).to.include("*literal* and $5");
  });
  it("resolves Markdown and HTML links/images without rewriting code or fragment links", function () {
    const dom = JSDOM.fragment(renderMarkdown('[Guide](../guide.md#top) [Local](#top)\n\n<img src="./x.png" srcset="x.png 1x, x2.png 2x">\n\n`<img src="x.png">`', "/r/repo/docs/"));
    expect(dom.querySelector("a").getAttribute("href")).to.equal("/r/repo/guide.md#top");
    expect(dom.querySelectorAll("a")[1].getAttribute("href")).to.equal("#top");
    expect(dom.querySelector("img").getAttribute("srcset")).to.equal("/r/repo/docs/x.png 1x, /r/repo/docs/x2.png 2x");
    expect(dom.querySelector("code").textContent).to.equal('<img src="x.png">');
  });
  it("renders GeoJSON polygons rather than their spherical complement", function () {
    const source = '```geojson\n{"type":"Polygon","coordinates":[[[-90,35],[-90,30],[-85,30],[-85,35],[-90,35]]]}\n```';
    const path = fragment(source).querySelector("svg path").getAttribute("d");
    expect(path.match(/M/g)).to.have.length(1);
    expect(path).not.to.match(/NaN|Infinity/);
  });
  it("centers a lone GeoJSON feature at its real coordinates", function () {
    const source = '```geojson\n{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[120,45]}}\n```';
    expect(fragment(source).querySelector("svg path").getAttribute("d")).to.include("M320,160");
  });
  it("does not leak references, slug counts, macros or base URLs between documents", function () {
    renderMarkdown("# Title\n\n[ref]: a.md\n\n[^a]: note\n\n$\\gdef\\custom{hello}$", "/first/");
    const dom = JSDOM.fragment(renderMarkdown("# Title\n\n[ref] [^a] [file](b.md) $\\custom$", "/second/"));
    expect(dom.querySelector("h1").id).to.equal("title");
    expect(dom.textContent).to.include("[ref] [^a]");
    expect(dom.querySelector('a[href="/second/b.md"]')).not.to.equal(null);
    expect(dom.querySelector(".katex").textContent).not.to.include("hello");
  });
  for (const language of ["geojson", "topojson", "stl"]) it(`keeps invalid ${language} readable`, function () {
    const dom = fragment(`\`\`\`${language}\nnot a diagram <script>alert(1)</script>\n\`\`\``);
    expect(dom.querySelector("pre code").textContent).to.include("not a diagram");
    expect(dom.querySelector("script")).to.equal(null);
  });
  it("blocks active content through HTML, TeX, images and generated-content spoofing", function () {
    const dom = fragment('<script>alert(1)</script>\n\n<svg onload="alert(1)"></svg><input type="text" autofocus><img srcset="javascript:alert(1) 1x"><span data-render-token="fake-0">Safe</span>\n\n$\\href{javascript:alert(1)}{click}$');
    expect(dom.querySelector("script,svg,[onload],[autofocus]")).to.equal(null);
    expect(dom.querySelector("input").disabled).to.equal(true);
    expect(dom.querySelector("input").type).to.equal("checkbox");
    for (const el of dom.querySelectorAll("[href],[src],[srcset]")) expect(el.outerHTML).not.to.include("javascript:");
  });

  it("serves the shared renderer through the project-page route", async function () {
    this.timeout(10000); // Includes cold TypeScript compilation of the route dependencies.
    const { Readable } = require("node:stream");
    const utils = require("../src/server/routes/route-utils");
    const File = require("../src/core/AnonymizedFile").default;
    const restores = [];
    const stub = (object, key, value) => { const previous = object[key]; restores.push(() => { object[key] = previous; }); object[key] = value; };
    try {
      stub(utils, "getRepo", async () => ({ options: { terms: [], page: true, pageSource: { path: "/", branch: "main" } }, model: { source: { branch: "main" } } }));
      stub(File.prototype, "getFileInfo", async () => ({ name: "README.md", path: "", size: 100 }));
      stub(File.prototype, "originalPath", async () => "README.md");
      stub(File.prototype, "isFileSupported", () => true);
      stub(File.prototype, "extension", () => "md");
      stub(File.prototype, "sha", async () => "sha");
      stub(File.prototype, "anonymizedContent", async () => Readable.from(["# Title\n\n> [!TIP]\n> Text with $x^2$ and note[^a].\n\n[^a]: Details"]));
      stub(File.prototype, "send", () => { throw new Error("Unexpected raw fallback"); });
      stub(utils, "handleError", error => { throw error; });
      const headers = {};
      let html;
      const res = {
        header(name, value) { headers[name] = value; return this; },
        set(name, value) { headers[name] = value; return this; },
        contentType() { return this; }, send(value) { html = value; return this; },
      };
      const handler = require("../src/server/routes/webview").default.stack[0].route.stack[0].handle;
      await handler({ path: "/repo/README.md", params: { repoId: "repo" }, headers: {}, method: "GET" }, res);
      const page = JSDOM.fragment(html);
      expect(page.querySelector("#title")).not.to.equal(null);
      expect(page.querySelector(".markdown-alert-tip .katex")).not.to.equal(null);
      expect(page.querySelector(".footnotes")).not.to.equal(null);
      expect(html).to.include('/script/markdown.min.js');
      expect(headers["Content-Security-Policy"]).to.include("sandbox");
      expect(headers["Content-Security-Policy"]).not.to.include("allow-same-origin");
    } finally { restores.reverse().forEach(restore => restore()); }
  });

  describe("shipped browser bundle", function () {
    let dom;
    before(function () {
      dom = new JSDOM("<!doctype html><body><main class='markdown-body'></main></body>", { runScripts: "outside-only", url: "https://viewer.test/" });
      dom.window.Object.hasOwn = undefined;
      dom.window.eval(fs.readFileSync(path.join(__dirname, "../public/script/markdown.min.js"), "utf8"));
      dom.window.eval(fs.readFileSync(path.join(__dirname, "../public/script/utils.js"), "utf8"));
    });
    after(function () { dom.window.close(); });
    it("matches the server renderer across the feature matrix", function () {
      for (const [name, source] of cases) {
        expect(normalizeFootnotes(dom.window.renderMD(source, "/r/repo/")), name).to.equal(normalizeFootnotes(renderMarkdown(source, "/r/repo/")));
      }
    });
    it("enhances Mermaid inserted while another diagram is rendering", async function () {
      const { setTimeout: delay } = require("node:timers/promises");
      const sources = [];
      let settings;
      dom.window.mermaid = {
        initialize(options) { settings = options; },
        async run({ nodes }) {
          sources.push(nodes[0].textContent);
          nodes[0].dataset.processed = "true";
          if (sources.length === 1) {
            dom.window.document.querySelector("main").insertAdjacentHTML("beforeend", dom.window.renderMD("~~~mermaid\ngraph TD; B-->C\n~~~"));
            await delay(10);
          }
        },
      };
      dom.window.document.querySelector("main").innerHTML = dom.window.renderMD("```mermaid\ngraph TD; A-->B\n```");
      await delay(80);
      expect(settings.securityLevel).to.equal("strict");
      expect(sources).to.deep.equal(["graph TD; A-->B", "graph TD; B-->C"]);
    });
    it("supports keyboard-activated diagram zoom and model rotation", function () {
      dom.window.document.querySelector("main").innerHTML = dom.window.renderMD(`\`\`\`stl\n${stl}\n\`\`\``);
      const figure = dom.window.document.querySelector("figure");
      figure.querySelector('[data-diagram-action="in"]').click();
      expect(figure.querySelector("g").getAttribute("transform")).to.include("scale(1.25)");
      const before = figure.querySelector("path").getAttribute("d");
      figure.querySelector('[data-diagram-action="rotate"]').click();
      expect(figure.querySelector("path").getAttribute("d")).not.to.equal(before);
      figure.querySelector('[data-diagram-action="reset"]').click();
      expect(figure.querySelector("g").getAttribute("transform")).to.include("scale(1)");
      expect(figure.querySelector("path").getAttribute("d")).to.equal(before);
    });
  });
});
