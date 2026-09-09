const { expect } = require("chai");
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const path = require("path");
const { URL } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");

const publicDir = path.join(__dirname, "../public");
const bundles = ["core.min.js", "vendor.min.js"].map(name => fs.readFileSync(path.join(publicDir, "script", name), "utf8"));

async function browser(route = "/", overrides = {}) {
  const errors = [], requests = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => {
    if (!error.message.includes("navigation (except hash changes)")) errors.push(error.message);
  });
  virtualConsole.on("error", error => errors.push(error?.message || String(error)));
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
    url: "http://localhost" + route, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole,
  });
  const window = dom.window;
  window.matchMedia = () => ({ matches: false });
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.fetch = async (url, options = {}) => {
    const target = new URL(url);
    const request = { url: target, ...options, payload: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    let data;
    const custom = overrides[target.pathname];
    if (custom !== undefined) data = typeof custom === "function" ? await custom(request) : custom;
    else if (target.pathname === "/api/user") data = null;
    else if (target.pathname === "/api/user/default") data = { options: {}, terms: [] };
    else if (/\/files\/$/.test(target.pathname)) data = [{ name: "hello.js", path: "", sha: "1", size: 8 }];
    else if (/\/files\/counts$/.test(target.pathname)) data = { "": 1 };
    else if (target.pathname === "/api/admin/errors") data = { entries: [] };
    else if (target.pathname === "/api/conferences/plans") data = [];
    else if (/\/options$|\/quota$|\/stats$|\/content$|\/api\/conferences\/[^/]+$/.test(target.pathname)) data = {};
    else if (/\/file\//.test(target.pathname)) data = "hello";
    else data = [];
    const status = data?.__status || 200;
    if (data?.__status) data = data.body;
    return { ok: status < 400, status, headers: { get: () => typeof data === "string" ? "text/plain" : "application/json" }, text: async () => typeof data === "string" ? data : JSON.stringify(data) };
  };
  bundles.forEach(bundle => window.eval(bundle));
  const app = window.anonymousApp;
  await app.router.isReady();
  await delay(30);
  return {
    window, app, errors, requests,
    async go(path) { await app.router.push(path); await delay(30); },
    async input(selector, value, event = "input") {
      const input = window.document.querySelector(selector);
      expect(input, selector).not.to.equal(null);
      input.value = value;
      input.dispatchEvent(new window.Event(event, { bubbles: true }));
      await delay(10);
      return input;
    },
    close() { app.app.unmount(); window.close(); },
  };
}

describe("Vue 3 UI", function () {
  this.timeout(15000);
  let ui;
  afterEach(() => ui?.close());

  it("renders every public and administrative route", async function () {
    ui = await browser();
    for (const route of ["/faq", "/anonymize", "/gist-anonymize", "/pull-request-anonymize", "/status/test", "/404", "/r/test/", "/repository/test/", "/pr/test/", "/gist/test/"]) {
      await ui.go(route);
      expect(ui.window.document.querySelector(".app-view").textContent, route + JSON.stringify(ui.errors)).not.to.equal("");
    }
    ui.app.state.user = { username: "tester", status: "ready", isAdmin: true };
    for (const route of ["/dashboard", "/claim", "/profile", "/conferences", "/conference/new", "/conference/test", "/conference/test/edit", "/admin/", "/admin/users", "/admin/users/test", "/admin/repositories", "/admin/conferences", "/admin/queues", "/admin/errors"]) {
      await ui.go(route);
      expect(ui.window.document.querySelector(".app-view").textContent, route + JSON.stringify(ui.errors)).not.to.equal("");
    }
    expect(ui.errors).to.deep.equal([]);
  });

  it("validates a claim, binds input values and renders server validation failures", async function () {
    ui = await browser("/claim", { "/api/repo/claim": { __status: 404, body: {} } });
    const form = ui.window.document.querySelector("form");
    form.dispatchEvent(new ui.window.Event("submit", { bubbles: true, cancelable: true }));
    expect(ui.requests.filter(r => r.method === "POST")).to.have.length(0);
    await ui.input("#repoUrl", "https://github.com/example/repository");
    await ui.input("#repoId", "anonymous-id");
    form.dispatchEvent(new ui.window.Event("submit", { bubbles: true, cancelable: true }));
    await delay(20);
    const request = ui.requests.find(r => r.method === "POST");
    expect(form.querySelector("#repoUrl").classList.contains("is-invalid")).to.equal(true);
    expect(request.payload).to.deep.equal({ repoUrl: "https://github.com/example/repository", repoId: "anonymous-id" });
    expect(ui.errors).to.deep.equal([]);
  });

  it("debounces model updates and flushes them on blur", async function () {
    ui = await browser("/profile", { "/api/user": { username: "tester" } });
    const input = await ui.input("#terms", "private-name");
    const form = ui.window.document.querySelector("form");
    input.dispatchEvent(new ui.window.Event("blur"));
    form.dispatchEvent(new ui.window.Event("submit", { bubbles: true, cancelable: true }));
    await delay(20);
    const request = ui.requests.find(r => r.method === "POST");
    expect(request.payload.terms).to.deep.equal(["private-name"]);
    expect(ui.errors).to.deep.equal([]);
  });

  it("keeps date values as local Dates and rejects out-of-range input", async function () {
    ui = await browser("/conference/new", { "/api/user": { username: "tester" } });
    const input = await ui.input("#startDate", "2027-02-15", "change");
    const bound = input._field.binding.value;
    expect(bound.getFullYear()).to.equal(2027);
    expect(bound.getMonth()).to.equal(1);
    expect(bound.getDate()).to.equal(15);
    input.min = "2027-03-01";
    input.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
    expect(input._field.validation.errors.min).to.equal(true);
    expect(ui.errors).to.deep.equal([]);
  });

  it("renders hostile filenames as text and updates the explorer without losing the tree", async function () {
    const filename = '{{constructor.constructor("window.probe=1")()}}.txt';
    ui = await browser("/r/test/hello.txt", {
      "/api/repo/test/files/": [{ name: filename, path: "", size: 1 }, { name: "constructor", path: "" }, { name: "index.js", path: "constructor", size: 2 }, { name: "hello.txt", path: "", size: 3 }],
    });
    const tree = ui.window.document.querySelector("tree");
    expect(tree.textContent).to.include(filename).and.include("constructor/index.js");
    expect(ui.window.probe).to.equal(undefined);
    await ui.go("/r/test/constructor/index.js");
    expect(ui.window.document.querySelector("tree")).to.equal(tree);
    expect(ui.requests.some(r => r.url.pathname === "/api/repo/test/file/constructor/index.js")).to.equal(true);
    await ui.go("/r/other/hello.txt");
    expect(ui.requests.some(r => r.url.pathname === "/api/repo/other/options")).to.equal(true);
    expect(ui.errors).to.deep.equal([]);
  });

  it("starts folders collapsed and opens the selected file's ancestors", async function () {
    ui = await browser("/r/test/hello.txt", {
      "/api/repo/test/files/": [
        { name: "hello.txt", path: "", size: 3 },
        { name: "src", path: "" },
        { name: "a.js", path: "src", size: 2 },
        { name: "b.js", path: "src", size: 2 },
        { name: "lazy", path: "" },
      ],
    });
    const folder = name => ui.window.document.querySelector(`tree a[data-path="/${name}"]`).parentElement;
    expect(folder("src").classList.contains("open")).to.equal(false);
    expect(folder("lazy").classList.contains("open")).to.equal(false);
    expect(folder("src").querySelector("ul")).to.equal(null);
    folder("src").querySelector("a").click();
    await delay(10);
    expect(folder("src").textContent).to.include("a.js");
    folder("src").querySelector("a").click();
    await delay(10);
    expect(folder("src").querySelector("ul")).to.equal(null);
    await ui.go("/r/test/src/a.js");
    expect(folder("src").classList.contains("open")).to.equal(true);
    expect(folder("lazy").classList.contains("open")).to.equal(false);
    folder("lazy").querySelector("a").click();
    await delay(10);
    expect(ui.requests.filter(r => r.url.pathname === "/api/repo/test/files/" && r.url.searchParams.get("path") === "lazy")).to.have.length(1);
    folder("lazy").querySelector("a").click();
    await delay(10);
    expect(ui.requests.filter(r => r.url.pathname === "/api/repo/test/files/" && r.url.searchParams.get("path") === "lazy")).to.have.length(1);
    expect(ui.errors).to.deep.equal([]);
  });

  it("reuses query-only routes but reloads PR and gist data when their IDs change", async function () {
    ui = await browser("/pr/first/");
    await ui.go("/pr/second/");
    await ui.go("/gist/first/");
    await ui.go("/gist/second/");
    expect(ui.requests.some(r => r.url.pathname === "/api/pr/second/content")).to.equal(true);
    expect(ui.requests.some(r => r.url.pathname === "/api/gist/second/content")).to.equal(true);
    const count = ui.requests.length;
    await ui.go("/gist/second/?tab=comments");
    expect(ui.requests).to.have.length(count);
    expect(ui.errors).to.deep.equal([]);
  });

  it("keeps rendered HTML in an opaque sandbox when scripts are enabled", async function () {
    ui = await browser("/r/test/report.html", { "/api/repo/test/file/report.html": '<h1>Report</h1><script>window.probe=1</script>' });
    const frame = ui.window.document.querySelector("html-doc iframe");
    expect(frame).not.to.equal(null);
    expect(frame.srcdoc).to.include("Report");
    expect(frame.getAttribute("sandbox")).not.to.include("allow-scripts");
    ui.window.document.querySelector('[aria-label="Allow this document to run JavaScript"]').click();
    await delay(20);
    const enabled = ui.window.document.querySelector("html-doc iframe");
    expect(enabled).not.to.equal(frame);
    expect(enabled.getAttribute("sandbox")).to.include("allow-scripts").and.not.include("allow-same-origin");
    expect(ui.window.probe).to.equal(undefined);
    expect(ui.errors).to.deep.equal([]);
  });

  it("filters loaded dashboard rows through search and status controls", async function () {
    ui = await browser("/dashboard", {
      "/api/user": { username: "tester" },
      "/api/user/anonymized_repositories": [
        { repoId: "alpha", status: "ready", source: { fullName: "owner/alpha" }, options: {}, pageView: 3 },
        { repoId: "beta", status: "ready", source: { fullName: "owner/beta" }, options: {}, pageView: 8 },
      ],
    });
    const rows = () => [...ui.window.document.querySelectorAll(".paper-table-row:not(.paper-table-skeleton)")];
    expect(rows()).to.have.length(2);
    await ui.input('input[type="search"]', "beta");
    expect(rows()).to.have.length(1);
    expect(rows()[0].textContent).to.include("beta");
    await ui.input('input[type="search"]', "");
    ui.window.document.querySelector("#status-ready").click();
    await delay(10);
    expect(rows()).to.have.length(0);
    expect(ui.errors).to.deep.equal([]);
  });

  it("locks edit identifiers and reactively displays the anonymized PR preview", async function () {
    ui = await browser("/pull-request-anonymize/test", {
      "/api/pr/test": { source: { repositoryFullName: "owner/repo", pullRequestId: 1 }, options: { terms: ["Alice"] } },
      "/api/pr/owner/repo/1": { pullRequest: { title: "Alice patch", body: "Alice body", comments: [] } },
      "/api/anonymize-preview": request => ({ contents: request.payload.contents.map(text => text.replaceAll("Alice", "MASKED")) }),
    });
    expect(ui.window.document.querySelector("#pullRequestId").disabled).to.equal(true);
    expect(ui.window.document.querySelector("#sourceUrl").disabled).to.equal(true);
    await delay(260);
    expect(ui.window.document.querySelector(".anonymize-preview-col").textContent).to.include("MASKED patch");
    expect(ui.errors).to.deep.equal([]);
  });

  it("loads PDF pages, changes documents and releases the previous document", async function () {
    ui = await browser("/faq");
    const loaded = [], destroyed = [];
    ui.window.pdfjsLib = { getDocument({ url }) {
      loaded.push(url);
      return { promise: Promise.resolve({
        numPages: 2,
        getPage: async () => ({ getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }), render: () => ({ promise: Promise.resolve() }) }),
        destroy() { destroyed.push(url); },
      }) };
    } };
    await ui.go("/r/test/first.pdf");
    expect(ui.window.document.querySelectorAll(".pdf-viewer-page")).to.have.length(2);
    await ui.go("/r/test/second.pdf");
    expect(loaded).to.have.length(2);
    expect(destroyed).to.deep.equal([loaded[0]]);
    await ui.go("/faq");
    expect(destroyed).to.deep.equal(loaded);
    expect(ui.errors).to.deep.equal([]);
  });

  it("leaves server routes and external links to the browser", async function () {
    ui = await browser();
    for (const href of ["/w/test/", "/api/repo/test/file/a", "/github/login", "https://example.org/"]) {
      const link = ui.window.document.createElement("a");
      link.href = href;
      ui.window.document.body.append(link);
      const event = new ui.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      link.dispatchEvent(event);
      expect(event.defaultPrevented, href).to.equal(false);
    }
    expect(ui.app.router.currentRoute.value.path).to.equal("/");
  });
});
