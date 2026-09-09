const { expect } = require("chai");
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { setImmediate } = require("timers");
const source = fs.readFileSync(path.join(__dirname, "../public/script/app.js"), "utf8");

function harness(date) {
  const defs = {}, routes = {}, timers = new Map();
  let timerId = 0;
  const context = { reactive: value => value, console, Map, Set, Date: date || Date,
    navigator: { platform: "Linux" }, document: { location: { pathname: "/r/repo" }, addEventListener() {}, querySelector() {} },
    window: {}, Prism: { highlightAll() {} }, encodeURIComponent,
    encodePathForUrl: p => p.split("/").map(encodeURIComponent).join("/"),
    humanFileSize: x => String(x), parseGithubUrl: () => ({ owner: "owner", repo: "repo" }),
    $: () => ({ on() {}, tooltip() {} }),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {},
  };
  context.createTimers = () => ({ timeout: Object.assign(context.setTimeout, { cancel: context.clearTimeout }), interval: Object.assign(context.setInterval, { cancel: context.clearInterval }) });
  context.createListeners = () => (target, name, callback) => target.addEventListener(name, callback);
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
    h.defs.profileController(h.scope, h.http, key => Promise.resolve(key), timeout, { load: () => Promise.resolve({}) });
    h.scope.saveDefault(); h.requests.at(-1).reject({ data: { error: "not_connected" } }); await h.flush();
    expect(h.scope.error).to.equal("ERRORS.not_connected");
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
      expect(out.scope.featureHref(out.scope.features.find(manage))).to.equal("/github/login");
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
