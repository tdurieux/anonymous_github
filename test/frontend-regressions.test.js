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
});
