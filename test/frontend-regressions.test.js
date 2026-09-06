const { expect } = require("chai");
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { setImmediate } = require("timers");
const source = fs.readFileSync(path.join(__dirname, "../public/script/app.js"), "utf8");

function harness(date) {
  const defs = {}, routes = {}, timers = new Map();
  let timerId = 0;
  const chain = new Proxy({}, { get: (_, method) => (...args) => {
    if (["controller", "directive"].includes(method)) defs[args[0]] = args[1];
    if (method === "config") {
      const route = { when(p, opt) { routes[p] = opt; return route; }, otherwise() {} };
      args[0].at(-1)(route, { html5Mode() {} }, { useStaticFilesLoader() {}, preferredLanguage() {} });
    }
    return chain;
  } });
  const context = { angular: { module: () => chain }, console, Map, Set, Date: date || Date,
    navigator: { platform: "Linux" }, document: { location: { pathname: "/r/repo" }, addEventListener() {}, querySelector() {} },
    window: {}, Prism: { highlightAll() {} }, encodeURIComponent,
    encodePathForUrl: p => p.split("/").map(encodeURIComponent).join("/"),
    humanFileSize: x => String(x), parseGithubUrl: () => ({ owner: "owner", repo: "repo" }),
    $: () => ({ on() {}, tooltip() {} }),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {},
  };
  vm.runInNewContext(source, context);
  const events = {}, watches = {};
  const scope = { $new() { return { $destroy() {} }; }, $on: (key, fn) => { (events[key] ||= []).push(fn); }, $watch: (key, fn) => { watches[key] = fn; }, $apply() {}, $applyAsync() {} };
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
  h.defs.exploreController.at(-1)(h.scope, h.http, { url: () => "/r/repo/README.md" }, h.params, { trustAsHtml: x => x }, h.q);
  h.navigate = path => { h.params.path = path; h.emit("$routeUpdate"); };
  return h;
}

describe("frontend production regressions", function () {
  it("keeps filenames and folder paths out of compiled Angular templates", function () {
    const h = harness(); let template;
    const element = { html() {}, append() {}, 0: { addEventListener() {}, setAttribute() {} } };
    h.scope.file = [{ name: '{{constructor.constructor("window.probe=1")()}}.txt', path: "", size: 1 }];
    h.scope.$parent = {};
    h.defs.tree[0]().controller.at(-1)(element, h.scope, {}, html => { template = html; return () => {}; });
    h.watches.file(h.scope.file);
    expect(template).not.to.include("constructor.constructor");
    expect(template).to.include('ng-bind="treeNodes[0].name"');
    expect(h.scope.treeNodes[0].name).to.equal(h.scope.file[0].name);
  });
  it("renders directories whose names collide with Object.prototype", function () {
    const h = harness(); let template;
    const element = { html() {}, 0: { addEventListener() {}, setAttribute() {} } };
    h.scope.file = [{ name: "constructor", path: "" }, { name: "index.js", path: "constructor", size: 1 }];
    h.scope.$parent = {};
    h.defs.tree[0]().controller.at(-1)(element, h.scope, {}, html => { template = html; return () => {}; });
    expect(() => h.watches.file(h.scope.file)).not.to.throw();
    expect(template).to.include("treeNodes");
    expect(h.scope.treeNodes[0].path).to.equal("/constructor/index.js");
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
    h.params.repoId = "new-repo"; h.emit("$routeUpdate");
    expect(h.scope.repoId).to.equal("new-repo"); expect(h.scope.files).to.have.length(0);
    expect(h.requests.at(-1).url).to.equal("/api/repo/new-repo/options");
  });
});
