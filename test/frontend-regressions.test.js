const { expect } = require("chai");
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { setImmediate } = require("timers");
const { URLSearchParams } = require("node:url");
const source = fs.readFileSync(path.join(__dirname, "../public/script/app.js"), "utf8");
require("ts-node/register/transpile-only");
const minimatch = require("minimatch");
const { compilePreserveMatcher, dedupePreservePatterns } = require("../src/core/preserve-files");
const { termHints, escapeTermLine } = require("../src/core/term-hints");

function harness(date) {
  const defs = {}, routes = {}, timers = new Map();
  let timerId = 0;
  const context = { reactive: value => value, console, Map, Set, Date: date || Date,
    formDraft: state => ({ restore: () => false, clear() {}, discard() {}, checkpoint: () => ({ terms: state.terms, options: state.options }), accept() {} }),
    navigator: { platform: "Linux" }, document: { location: { pathname: "/r/repo" }, addEventListener() {}, querySelector() {} },
    URLSearchParams, window: { location: { search: "" }, addEventListener() {}, removeEventListener() {} }, Prism: { highlightAll() {} }, encodeURIComponent,
    encodePathForUrl: p => p.split("/").map(encodeURIComponent).join("/"),
    humanFileSize: x => String(x), loadEditor: async () => {}, parseGithubUrl: () => ({ owner: "owner", repo: "repo" }),
    $: () => ({ on() {}, tooltip() {} }),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {},
    markRaw: value => value, globEscape: minimatch.escape, globUnescape: minimatch.unescape,
    compilePreserveMatcher, dedupePreservePatterns, termHints, escapeTermLine,
  };
  context.createTimers = () => ({ timeout: Object.assign(context.setTimeout, { cancel: context.clearTimeout }), interval: Object.assign(context.setInterval, { cancel: context.clearInterval }) });
  context.createListeners = () => (target, name, callback) => target.addEventListener(name, callback);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/script/billing.js"), "utf8").replaceAll("export function", "function"), context);
  context.createPageState = parent => Object.create(parent);
  const viewerSource = fs.readFileSync(path.join(__dirname, "../public/script/file-viewer.js"), "utf8");
  vm.runInNewContext(viewerSource.replace(/^import .*;$/gm, "").replace(/export const/g, "var"), context);
  const names = [...source.matchAll(/export const (\w+)/g)].map(match => match[1]);
  vm.runInNewContext(source.replace(/^import .*;$/gm, "").replace(/export const/g, "var") + "\nthis.pageSetups = {" + names.join(",") + "};", context);
  Object.assign(defs, context.pageSetups);
  const routeSource = fs.readFileSync(path.join(__dirname, "../public/script/routes.js"), "utf8");
  const routeContext = { pages: defs, admin: {} };
  vm.runInNewContext(routeSource.replace(/^import .*;$/gm, "").replace("export const pageRoutes", "this.pageRoutes"), routeContext);
  routeContext.pageRoutes.forEach(route => { routes[route.path] = route; });
  const events = {}, watches = {};
  const scope = { $new() { return { dispose() {} }; }, on: (key, fn) => { (events[key] ||= []).push(fn); }, watch: (key, fn) => { watches[key] = fn; }, $apply() {}, $applyAsync() {} };
  const requests = [];
  const http = {};
  for (const method of ["get", "post"]) http[method] = (url, body) => new Promise((resolve, reject) => requests.push({ method, url, body, resolve, reject }));
  const q = { resolve: () => Promise.resolve(), reject: e => Promise.reject(e), defer: () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; } };
  return { defs, routes, scope, http, requests, q, events, watches, timers, context,
    emit: key => (events[key] || []).forEach(fn => fn()),
    flush: () => new Promise(resolve => setImmediate(resolve)),
  };
}
function explorer() {
  const h = harness(); h.params = { repoId: "repo", path: "README.md" };
  h.defs.exploreController(h.scope, h.http, { url: () => "/r/repo/README.md" }, h.params, { trustAsHtml: x => x }, h.q);
  h.navigate = path => { h.params.path = path; h.emit("routeUpdate"); };
  return h;
}

describe("frontend production regressions", function () {
  describe("conference defaults on edit (#791)", function () {
    const conferenceData = () => ({
      startDate: "2026-01-01", endDate: "2026-12-31",
      options: { update: true, image: true, pdf: true, notebook: true, link: true },
    });
    function anonymize(params = {}) {
      const h = harness();
      h.defs.anonymizeController(h.scope, h.http, {}, params, {}, () => {}, Object.assign(() => 0, { cancel() {} }));
      return h;
    }
    for (const id of ["repoId", "pullRequestId", "gistId"]) {
      it(`preserves saved options when reopening a conference-linked ${id}`, async function () {
        const h = anonymize({ [id]: "saved" });
        h.requests.find(r => r.url === "/api/user/default").resolve({ data: { options: { update: true } } }); await h.flush();
        h.requests.at(-1).resolve({ data: {
          source: { fullName: "owner/repo", repositoryFullName: "owner/repo", branch: "main", commit: "abcdef", gistId: "123", pullRequestId: 1 },
          conference: "conf",
          options: { terms: [], update: false, image: false, expirationMode: "remove", expirationDate: "2026-11-01" },
        } }); await h.flush();
        h.watches.conference();
        h.requests.at(-1).resolve({ data: conferenceData() }); await h.flush();
        expect(h.scope.options.update).to.equal(false);
        expect(h.scope.options.image).to.equal(false);
        expect(h.scope.options.expirationDate.toISOString()).to.equal("2026-11-01T00:00:00.000Z");
        expect(h.scope.conference_data).not.to.equal(null);
        if (id === "repoId") {
          h.requests.find(r => r.url === "/api/repo/owner/repo/").resolve({ data: { repo: "repo", defaultBranch: "main" } });
          h.requests.find(r => r.url === "/api/repo/owner/repo/readme").resolve({ data: "README" });
          await h.flush();
          h.requests.find(r => r.url === "/api/repo/owner/repo/branches").resolve({ data: [{ name: "main", commit: "abcdef", readme: "README" }] });
          await h.flush();
          h.scope.anonymizeRepo({ target: {} });
          expect(h.requests.at(-1).body.options.update).to.equal(false);
          expect(h.requests.at(-1).url).to.equal("/api/repo/saved");
        }
      });
    }
    it("applies defaults when selecting a different conference", async function () {
      const h = anonymize();
      h.scope.isUpdate = true; h.scope._originalConference = "old";
      h.scope.conference = "new"; h.watches.conference();
      h.requests.at(-1).resolve({ data: conferenceData() }); await h.flush();
      expect(h.scope.options.update).to.equal(true);
      expect(h.scope.options.expirationDate.toISOString()).to.equal("2026-12-31T00:00:00.000Z");
    });
    it("ignores defaults arriving after a conference is deselected", async function () {
      const h = anonymize(); h.scope.conference = "conf"; h.watches.conference();
      const pending = h.requests.at(-1);
      h.scope.conference = ""; h.watches.conference();
      pending.resolve({ data: conferenceData() }); await h.flush();
      expect(h.scope.options.update).to.equal(false);
      expect(h.scope.conference_data).to.equal(null);
    });
  });
  it("sanitizes Org output before trusting it", async function () {
    const h = explorer(); let untrusted;
    h.context.Org = { Parser: function () { this.parse = () => ({ convert: () => ({ toString: () => '<img onerror="probe()">' }) }); }, ConverterHTML: {} };
    h.context.contentAbs2Relative = x => x;
    h.context.DOMPurify = { sanitize: html => { untrusted = html; return "sanitized"; } };
    h.navigate("file.org"); h.requests.at(-1).resolve({ data: "org source", headers: () => "text/plain" }); await h.flush();
    expect(untrusted).to.include("onerror"); expect(h.scope.content).to.equal("sanitized");
  });
  it("ignores stale successes and failures after selecting another file", async function () {
    const h = explorer();
    h.navigate("first.js"); const first = h.requests.at(-1);
    h.navigate("second.js"); const second = h.requests.at(-1);
    second.resolve({ data: "SECOND", headers: () => "text/plain" }); await h.flush();
    first.resolve({ data: "FIRST", headers: () => "text/plain" }); await h.flush();
    expect(h.scope.content).to.equal("SECOND");
    h.navigate("third.js"); const third = h.requests.at(-1);
    h.navigate("fourth.pdf"); third.reject({ status: 500 }); await h.flush();
    expect(h.scope.type).to.equal("pdf");
  });
  it("reloads the repository when only its ID changes", function () {
    const h = explorer(); h.scope.files = [{ name: "old", path: "old" }];
    h.params.repoId = "new-repo"; h.emit("routeUpdate");
    expect(h.scope.repoId).to.equal("new-repo"); expect(h.scope.files).to.have.length(0);
    expect(h.requests.at(-1).url).to.equal("/api/repo/new-repo/options");
  });
  it("reloads PR and Gist controllers for new resource IDs", function () {
    const h = harness();
    for (const route of ["/pr/:pullRequestId/:path(.*)*", "/gist/:gistId/:path(.*)*"]) {
      expect(h.routes[route].preserveExplorer).to.equal(false);
    }
  });
  it("saves picked files as anchored, escaped paths and folders as patterns (#941)", async function () {
    const h = harness(); const timeout = () => 0; timeout.cancel = () => {};
    h.context.document.getElementById = () => null;
    h.defs.anonymizeController(h.scope, h.http, {}, {}, {}, () => {}, timeout);
    h.scope.options.preserveFiles = ["*.bib"];
    h.scope.source = { commit: "a".repeat(40) };
    h.scope.sourceUrl = "https://github.com/owner/repo";
    h.scope.openPreserveFiles();
    const request = h.requests.at(-1);
    expect(request.url).to.equal("/api/repo/owner/repo/tree");
    expect(request.body.params.commit).to.equal("a".repeat(40));
    request.resolve({ data: { files: ["configs/a.yaml", "configs/b.yaml", "paper/[draft].tex", "paper/refs.bib"], truncated: false } });
    await h.flush();
    expect(h.scope.preserveCount()).to.equal(1);
    h.scope.togglePreserveFile("paper/[draft].tex");
    h.scope.togglePreserveFolder("configs");
    expect(h.scope.preserveCount()).to.equal(4);
    h.scope.savePreserveFiles();
    expect(Array.from(h.scope.options.preserveFiles)).to.deep.equal(["/paper/\\[draft\\].tex", "*.bib", "/configs/**"]);
    expect(h.scope.preserveSummary()).to.equal("paper/[draft].tex, *.bib and 1 more");
  });
  it("lets a later !pattern exclude a picked file, and keeps braces literal (#941)", async function () {
    const h = harness(); const timeout = () => 0; timeout.cancel = () => {};
    h.context.document.getElementById = () => null;
    h.defs.anonymizeController(h.scope, h.http, {}, {}, {}, () => {}, timeout);
    h.scope.options.preserveFiles = ["/paper/\\{a,b\\}.bib", "!a.bib"];
    h.scope.source = { commit: "a".repeat(40) };
    h.scope.sourceUrl = "https://github.com/owner/repo";
    h.scope.openPreserveFiles();
    expect(h.scope.preserve.picked["paper/{a,b}.bib"]).to.equal(true);
    h.requests.at(-1).resolve({ data: { files: ["a.bib", "paper/a.bib", "paper/{a,b}.bib"], truncated: false } });
    await h.flush();
    expect(h.scope.preserveCount()).to.equal(1);
    h.scope.togglePreserveFile("a.bib");
    expect(h.scope.preserveCount()).to.equal(1);
  });
  it("keeps folder rules as patterns and counts them like the server (#941)", async function () {
    const h = harness(); const timeout = () => 0; timeout.cancel = () => {};
    h.context.document.getElementById = () => null;
    h.defs.anonymizeController(h.scope, h.http, {}, {}, {}, () => {}, timeout);
    h.scope.options.preserveFiles = ["/paper/", "/refs.bib"];
    h.scope.source = { commit: "abc123" };
    h.scope.sourceUrl = "https://github.com/owner/repo";
    h.scope.openPreserveFiles();
    expect(Object.keys(h.scope.preserve.picked)).to.deep.equal([]);
    expect(h.scope.preserve.patterns).to.equal("/paper/\n/refs.bib");
    h.requests.at(-1).resolve({ data: { files: ["paper/a.tex", "paper/b/c.tex", "refs.bib", "x.tex"], truncated: false } });
    await h.flush();
    expect(h.scope.preserveCount()).to.equal(3);
    const paper = h.scope.preserveRows().find((row) => row.path === "paper");
    expect(paper.state).to.equal("all");
  });
  it("unchecking a folder overrides broader rules (#941)", async function () {
    const h = harness(); const timeout = () => 0; timeout.cancel = () => {};
    h.context.document.getElementById = () => null;
    h.defs.anonymizeController(h.scope, h.http, {}, {}, {}, () => {}, timeout);
    h.scope.options.preserveFiles = ["*.bib"];
    h.scope.source = { commit: "abc123" };
    h.scope.sourceUrl = "https://github.com/owner/repo";
    h.scope.openPreserveFiles();
    h.requests.at(-1).resolve({ data: { files: ["paper/refs.bib", "refs.bib"], truncated: false } });
    await h.flush();
    expect(h.scope.preserveCount()).to.equal(2);
    h.scope.togglePreserveFolder("paper");
    expect(h.scope.preserveCount()).to.equal(1);
    h.scope.togglePreserveFolder("paper");
    expect(h.scope.preserveCount()).to.equal(2);
    h.scope.togglePreserveFolder("paper");
    h.scope.savePreserveFiles();
    expect(Array.from(h.scope.options.preserveFiles)).to.deep.equal(["*.bib", "!/paper/"]);
  });
  it("keeps the order of saved rules when the picker opens and saves (#941)", function () {
    const h = harness(); const timeout = () => 0; timeout.cancel = () => {};
    h.context.document.getElementById = () => null;
    h.defs.anonymizeController(h.scope, h.http, {}, {}, {}, () => {}, timeout);
    h.scope.options.preserveFiles = ["/a.bib", "*.bib", "!/refs.bib", "/refs.bib"];
    h.scope.source = { commit: "a".repeat(40) };
    h.scope.sourceUrl = "https://github.com/owner/repo";
    h.scope.openPreserveFiles();
    expect(Object.keys(h.scope.preserve.picked)).to.deep.equal(["a.bib"]);
    expect(h.scope.preserve.patterns).to.equal("*.bib\n!/refs.bib\n/refs.bib");
    h.scope.savePreserveFiles();
    expect(Array.from(h.scope.options.preserveFiles)).to.deep.equal(["/a.bib", "*.bib", "!/refs.bib", "/refs.bib"]);
  });
  it("shows the README unredacted in the preview when it is an unredacted file (#941)", function () {
    const h = harness(); const timeout = () => 0; timeout.cancel = () => {};
    h.defs.anonymizeController(h.scope, h.http, {}, {}, {}, () => {}, timeout);
    h.scope.detectedType = "repo";
    h.scope.options.preserveFiles = ["*.bib"];
    expect(h.scope.readmePreserved()).to.equal(false);
    h.scope.options.preserveFiles = ["/README.md"];
    expect(h.scope.readmePreserved()).to.equal(true);
    expect(typeof h.watches["options.preserveFiles"]).to.equal("function");
  });
  it("redacts the root README when only docs/ is left unredacted, and finds the README GitHub shows", async function () {
    const h = harness(); const timeout = () => 0; timeout.cancel = () => {};
    h.context.document.getElementById = () => null;
    h.defs.anonymizeController(h.scope, h.http, {}, {}, {}, () => {}, timeout);
    h.scope.detectedType = "repo";
    h.scope.options.preserveFiles = ["/docs/**"];
    // Before the tree loads only the root README names are assumed.
    expect(h.scope.readmePreserved()).to.equal(false);
    expect(h.scope.readmeName()).to.equal("README.md");
    h.scope.options.preserveFiles = ["docs/"];
    expect(h.scope.readmePreserved()).to.equal(false);
    h.scope.source = { commit: "a".repeat(40) };
    h.scope.sourceUrl = "https://github.com/owner/repo";
    h.scope.openPreserveFiles();
    h.requests.at(-1).resolve({ data: { files: ["Readme.markdown", "docs/README.md", "readme.txt", "src/a.py"], binaryFiles: ["fig.png"], truncated: false } });
    await h.flush();
    expect(h.scope.readmePath()).to.equal("Readme.markdown");
    expect(h.scope.readmeName()).to.equal("Readme.markdown");
    expect(h.scope.readmePreserved()).to.equal(false);
    h.scope.options.preserveFiles = ["*.markdown"];
    expect(h.scope.readmePreserved()).to.equal(true);
    // .github/ comes first, then the root, then docs/.
    h.scope.source = { commit: "b".repeat(40) };
    h.scope.preserve.commit = "";
    h.scope.openPreserveFiles();
    h.requests.at(-1).resolve({ data: { files: [".github/README.md", "README.md"], truncated: false } });
    await h.flush();
    expect(h.scope.readmePath()).to.equal(".github/README.md");
    // The preview's tree lists binary files too, and marks the open file.
    h.scope.source = { commit: "c".repeat(40) };
    h.scope.preserve.commit = "";
    h.scope.openPreserveFiles();
    h.requests.at(-1).resolve({ data: { files: ["README.md", "src/a.py"], binaryFiles: ["fig.png"], truncated: false } });
    await h.flush();
    expect(Array.from(h.scope.previewTreeFiles(), row => row.name)).to.include.members(["a.py", "fig.png", "README.md"]);
  });
  it("opens a file of the preview tree, redacted like the README unless it is left unredacted", async function () {
    const h = harness(); const pending = []; const timeout = fn => { pending.push(fn); return pending.length; }; timeout.cancel = () => {};
    h.context.document.getElementById = () => null;
    h.defs.anonymizeController(h.scope, h.http, {}, {}, {}, () => {}, timeout);
    h.scope.detectedType = "repo";
    h.scope.terms = "Jane Smith";
    h.scope.source = { commit: "a".repeat(40), branch: "main" };
    h.scope.sourceUrl = "https://github.com/owner/repo";
    h.scope.openPreserveFiles();
    h.requests.at(-1).resolve({ data: { files: ["README.md", "paper/refs.bib", "src/a.py"], binaryFiles: ["fig.png"], truncated: false } });
    await h.flush();
    h.scope.openPreviewFile("src/a.py");
    const file = h.requests.at(-1);
    expect(file.url).to.equal("/api/repo/owner/repo/file");
    expect(file.body.params).to.include({ commit: "a".repeat(40), path: "src/a.py" });
    expect(h.scope.previewStatus).to.equal("loading");
    file.resolve({ data: "# Jane Smith\nprint(1)\n", headers: () => "text/plain; charset=utf-8" });
    await h.flush();
    pending.splice(0).forEach(fn => fn());
    const preview = h.requests.at(-1);
    expect(preview.url).to.equal("/api/anonymize-preview");
    expect(preview.body.content).to.equal("# Jane Smith\nprint(1)\n");
    expect(Array.from(preview.body.options.terms)).to.deep.equal(["Jane Smith"]);
    preview.resolve({ data: { content: "# XXXX-1\nprint(1)\n" } });
    await h.flush();
    expect(h.scope.previewStatus).to.equal("ready");
    expect(h.scope.previewRedactions()).to.equal(1);
    expect(h.scope.previewViewer.content).to.equal("# XXXX-1\nprint(1)\n");
    expect(h.scope.previewViewer.aceOption.mode).to.equal("python");
    expect(h.scope.previewViewer.languageName).to.equal("Python");
    // The server receives the terms and preservation rules, just like the streamer.
    h.scope.options.preserveFiles = ["*.bib"];
    h.scope.openPreviewFile("paper/refs.bib");
    h.requests.at(-1).resolve({ data: "author = {Jane Smith}", headers: () => "text/plain" });
    await h.flush();
    pending.splice(0).forEach(fn => fn());
    expect(Array.from(h.requests.at(-1).body.options.terms)).to.deep.equal(["Jane Smith"]);
    expect(h.requests.at(-1).body.options.filePath).to.equal("paper/refs.bib");
    expect(Array.from(h.requests.at(-1).body.options.preserveFiles)).to.deep.equal(["*.bib"]);
    expect(h.scope.previewPreserved()).to.equal(true);
    // Binary files are not fetched; the server's { binary: true } is a note too.
    const before = h.requests.length;
    h.scope.openPreviewFile("fig.png");
    expect(h.requests.length).to.equal(before);
    expect(h.scope.previewViewer.type).to.equal("binary");
    expect(h.scope.previewStatus).to.equal("ready");
    h.scope.openPreviewFile("src/a.py");
    h.requests.at(-1).resolve({ data: JSON.stringify({ binary: true, size: 10 }), headers: () => "application/json; charset=utf-8" });
    await h.flush();
    expect(h.scope.previewViewer.type).to.equal("binary");
    // Back to the README.
    h.scope.openPreviewFile("README.md");
    expect(h.scope.previewFile).to.equal("");
  });
  it("includes PR comment authors and bodies in the preview batch", async function () {
    const h = harness(); const pending = new Map(); let id = 0;
    const timeout = fn => { pending.set(++id, fn); return id; }; timeout.cancel = id => pending.delete(id);
    h.defs.anonymizeController(h.scope, h.http, {}, {}, {}, () => {}, timeout);
    h.scope.detectedType = "pr"; h.scope.terms = "Alice";
    h.scope.details = { pullRequest: { title: "title", comments: [{ author: "Alice", body: "Alice comment" }] } };
    h.watches.terms(); [...pending.values()][0]();
    const request = h.requests.at(-1);
    expect(Array.from(request.body.contents)).to.deep.equal(["title", "Alice", "Alice comment"]);
    request.resolve({ data: { contents: ["title", "MASK", "MASK comment"] } }); await h.flush();
    expect(h.scope.anonymizePrContent("Alice")).to.equal("MASK");
  });
  it("selects the diff tab after asynchronous PR loading", async function () {
    const h = harness(); h.defs.pullRequestController(h.scope, h.http, {}, { pullRequestId: "pr" }, {});
    h.requests[0].resolve({ data: {} }); await h.flush();
    h.requests[1].resolve({ data: { diff: "patch" } }); await h.flush();
    expect(h.scope.tabState.active).to.equal("diff");
    const template = fs.readFileSync(path.join(__dirname, "../public/partials/pullRequest.htm"), "utf8");
    expect(template).not.to.include('ng-init="tabState');
  });
  it("finishes failed searches without letting canceled requests reset the next search", async function () {
    const h = explorer(); h.scope.fileSearchQuery = "old"; h.scope.onFileSearchChange(); const old = h.requests.at(-1);
    h.scope.fileSearchQuery = "new"; h.scope.onFileSearchChange(); const current = h.requests.at(-1);
    old.reject({ status: -1 }); await h.flush(); expect(h.scope.fileSearchLoading).to.equal(true);
    current.reject({ status: 500 }); await h.flush(); expect(h.scope.fileSearchLoading).to.equal(false);
    expect(h.scope.fileSearchResults).to.have.length(0);
  });
  it("cancels status polling on destroy, including late responses", async function () {
    const h = harness(); h.defs.statusController(h.scope, h.http, { repoId: "repo" });
    h.requests[0].resolve({ data: { status: "preparing" } }); await h.flush();
    expect(h.timers.size).to.equal(1); const callback = [...h.timers.values()][0];
    h.emit("dispose"); expect(h.timers.size).to.equal(0); callback(); expect(h.requests).to.have.length(1);
    const late = harness(); late.defs.statusController(late.scope, late.http, { repoId: "repo" });
    late.emit("dispose"); late.requests[0].resolve({ data: { status: "preparing" } }); await late.flush(); expect(late.timers.size).to.equal(0);
  });
  it("translates profile save failures", async function () {
    const h = harness(); expect(h.defs.profileController.toString()).to.include("translate");
    const timeout = Object.assign(() => 0, { cancel() {} });
    h.defs.profileController(h.scope, h.http, key => Promise.resolve(key === "ERRORS.not_connected" ? "Please sign in again." : key), timeout, { load: () => Promise.resolve({}) });
    h.scope.saveDefault(); h.requests.at(-1).reject({ data: { error: "not_connected" } }); await h.flush();
    expect(h.scope.error).to.equal("Please sign in again.");
  });
  describe("landing page features", function () {
    const home = fs.readFileSync(path.join(__dirname, "..", "public", "partials", "home.htm"), "utf8");
    function landing(user) {
      const h = harness(); h.scope.user = user;
      const focused = []; h.focused = focused;
      const win = { document: { getElementById: id => ({ focus: () => focused.push(id) }) } };
      const timeout = fn => fn();
      h.defs.homeController(h.scope, h.http, { url() {} }, win, timeout);
      return h;
    }
    it("selects the first feature and switches on click", function () {
      const h = landing(null);
      expect(h.scope.feature).to.equal("anonymize");
      h.scope.selectFeature("manage"); expect(h.scope.feature).to.equal("manage");
    });
    it("moves between tabs with the arrow keys, wrapping and moving focus", function () {
      const h = landing(null); let prevented = 0;
      const key = k => ({ key: k, preventDefault: () => prevented++ });
      h.scope.featureKeydown(key("ArrowDown"), 0); expect(h.scope.feature).to.equal("review");
      h.scope.featureKeydown(key("ArrowUp"), 1); expect(h.scope.feature).to.equal("anonymize");
      h.scope.featureKeydown(key("ArrowUp"), 0); expect(h.scope.feature).to.equal("manage");
      h.scope.featureKeydown(key("End"), 0); expect(h.scope.feature).to.equal("manage");
      h.scope.featureKeydown(key("Home"), 2); expect(h.scope.feature).to.equal("anonymize");
      h.scope.featureKeydown(key("Tab"), 0); expect(h.scope.feature).to.equal("anonymize");
      expect(prevented).to.equal(5);
      expect(h.focused).to.deep.equal(["review", "anonymize", "manage", "manage", "anonymize"].map(k => "feature-tab-" + k));
    });
    it("sends signed-out visitors to sign in instead of the dashboard", function () {
      const manage = f => f.key === "manage";
      const out = landing(null);
      expect(out.scope.featureHref(out.scope.features.find(manage))).to.equal("/signin");
      expect(out.scope.featureTarget(out.scope.features.find(manage))).to.equal("_self");
      const signedIn = landing({ username: "jane" });
      expect(signedIn.scope.featureHref(signedIn.scope.features.find(manage))).to.equal("/dashboard");
      expect(signedIn.scope.featureTarget(signedIn.scope.features.find(manage))).to.equal(undefined);
    });
    it("marks the tabs up as tabs and keeps links out of the buttons", function () {
      expect(home).to.match(/<button[^>]*class="paper-feature-tab"[^>]*role="tab"/);
      expect(home).to.match(/role="tablist"/);
      expect(home).to.match(/role="tabpanel"[^>]*:aria-labelledby=/);
      const button = home.slice(home.indexOf('class="paper-feature-tab"'), home.indexOf("</button>"));
      expect(button).to.not.include("<a ");
      expect(home).to.not.match(/href="#"/);
    });
  });
  it("keeps the conference end date after the start across December", function () {
    class December extends Date { constructor(...args) { super(...(args.length ? args : ["2026-12-15T12:00:00Z"])); } }
    const h = harness(December); h.scope.user = {};
    h.defs.newConferenceController(h.scope, h.http, {}, {});
    expect(h.scope.options.startDate.getFullYear()).to.equal(2027);
    expect(h.scope.options.endDate.getTime()).to.be.greaterThan(h.scope.options.startDate.getTime());
  });
});

describe("redaction highlighting", () => {
  const { JSDOM } = require("jsdom");
  function helpers() {
    const { window } = new JSDOM("");
    const h = harness();
    Object.assign(h.context, { DOMParser: window.DOMParser, NodeFilter: window.NodeFilter });
    return h.defs;
  }
  it("matches the mask with and without a counter", () => {
    const { redactionPattern } = helpers();
    expect("by XXXX-1 and XXXX-12 at XXXX.".match(redactionPattern("XXXX"))).to.deep.equal(["XXXX-1", "XXXX-12", "XXXX"]);
    expect("a.b-3 axb-3".match(redactionPattern("a.b"))).to.deep.equal(["a.b-3"]);
  });
  it("marks redactions in text without touching attributes", () => {
    const { highlightRedactions } = helpers();
    const html = highlightRedactions('<p>By XXXX-1 <a href="https://x.test/XXXX-2">link</a></p>', "XXXX");
    expect(html).to.include('By <mark class="redaction" title="Redacted by Anonymous GitHub">XXXX-1</mark>');
    expect(html).to.include('href="https://x.test/XXXX-2"');
    expect(highlightRedactions("<p>nothing here</p>", "XXXX")).to.equal("<p>nothing here</p>");
  });
  it("leaves Mermaid sources and Prism code blocks for their renderers", () => {
    const { highlightRedactions } = helpers();
    const html = highlightRedactions('<div class="mermaid">graph TD; XXXX-1--&gt;B</div><pre><code class="language-py">print("XXXX-2")</code></pre><code>XXXX-3</code>', "XXXX");
    expect(html).to.include('<div class="mermaid">graph TD; XXXX-1--&gt;B</div>');
    expect(html).to.include('<code class="language-py">print("XXXX-2")</code>');
    expect(html).to.include('<code><mark class="redaction" title="Redacted by Anonymous GitHub">XXXX-3</mark></code>');
  });
  it("marks a highlighted code block when Prism hands it over, using the configured mask", () => {
    const { window } = new (require("jsdom").JSDOM)('<pre><code class="language-py"><span class="token string">"MASK-4"</span></code></pre>');
    const h = harness();
    Object.assign(h.context, { DOMParser: window.DOMParser, NodeFilter: window.NodeFilter });
    h.defs.setRedactionMask("MASK");
    const code = window.document.querySelector("code");
    h.defs.markRedactionsIn(code);
    expect(code.querySelector("mark.redaction").textContent).to.equal("MASK-4");
  });
});
