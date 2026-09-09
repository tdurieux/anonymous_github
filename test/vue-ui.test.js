const { expect } = require("chai");
const { JSDOM, VirtualConsole, ResourceLoader } = require("jsdom");
const fs = require("fs");
const path = require("path");
const { URL } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");

const publicDir = path.join(__dirname, "../public");
const bundles = ["core.min.js", "vendor.min.js"].map(name => fs.readFileSync(path.join(publicDir, "script", name), "utf8"));

async function browser(route = "/", overrides = {}, storage = {}) {
  const errors = [], requests = [], assets = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => {
    if (!error.message.includes("navigation (except hash changes)")) errors.push(error.message);
  });
  virtualConsole.on("error", error => errors.push(error?.message || String(error)));
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
    resources: new class extends ResourceLoader {
      fetch(url) {
        assets.push(new URL(url).pathname);
        if (/\/pdf\.[a-f0-9]+\.min\.js$/.test(new URL(url).pathname) && dom.window.pdfjsLib) return Promise.resolve(Buffer.from(""));
        const pathname = new URL(url).pathname.replace(/\.[a-f0-9]{10}\.min\.js$/, ".min.js");
        if (pathname.startsWith("/script/")) return Promise.resolve(fs.readFileSync(path.join(publicDir, pathname)));
        return null;
      }
    }(),
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
  for (const [key, value] of Object.entries(storage)) window.sessionStorage.setItem(key, JSON.stringify(value));
  bundles.forEach(bundle => window.eval(bundle));
  const app = window.anonymousApp;
  await app.router.isReady();
  await delay(30);
  return {
    window, app, errors, requests, assets,
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

  it("offers App and OAuth sign-in and direct repository access links", async function () {
    ui = await browser("/signin", { "/api/options": { GITHUB_APP_ENABLED: true, GITHUB_OAUTH_ENABLED: true } });
    expect(ui.window.document.querySelector('a[href="/github/app/login"]')).not.to.equal(null);
    expect(ui.window.document.querySelector('a[href="/github/login"]')).not.to.equal(null);
    expect(ui.errors).to.deep.equal([]);
  });

  it("previews a connection migration before switching and includes CSRF protection", async function () {
    const resource = { type: "repository", id: "saved", name: "owner/private", connection: "oauth", status: "ready" };
    ui = await browser("/connections", {
      "/api/user": { username: "owner" },
      "/github/connections": { csrf: "csrf-value", appEnabled: true, appConnected: true, oauthEnabled: true, oauthConnected: true,
        installations: [{ id: 4, account: "owner" }], gistCount: 0, resources: [resource] },
      "/github/connections/migrate": request => request.payload.preview ? { eligible: true } : { connection: "github-app" },
    });
    const button = label => [...ui.window.document.querySelectorAll("button")].find(node => node.textContent.includes(label));
    expect(button("Switch to read-only access")).to.equal(undefined);
    expect(ui.window.document.querySelector('a[href="/github/app/install?installationId=4"]')).not.to.equal(null);
    button("Check read-only access").click();
    await delay(30);
    button("Switch to read-only access").click();
    await delay(30);
    const changes = ui.requests.filter(r => r.url.pathname === "/github/connections/migrate");
    expect(changes).to.have.length(2);
    expect(changes[0].payload.preview).to.equal(true);
    expect(changes[1].payload.preview).to.equal(false);
    expect(changes[1].payload.connection).to.equal("github-app");
    expect(changes[1].headers["X-CSRF-Token"]).to.equal("csrf-value");
    expect(ui.errors).to.deep.equal([]);
  });


  it("preserves redactions, identifiers and pinned commits when switching connections", async () => {
    ui = await browser("/anonymize", {
      "/github/connections": { appEnabled: true, oauthConnected: true },
      "/api/repo/owner/repo/": { defaultBranch: "main", repo: "repo" },
      "/api/repo/owner/repo/branches": [{ name: "main", commit: "abcdef123" }],
      "/api/repo/owner/repo/readme": "",
    });
    const url = await ui.input("#sourceUrl", "https://github.com/owner/repo");
    url.dispatchEvent(new ui.window.Event("blur"));
    await delay(50);
    await ui.input("#terms", "Private Author");
    await delay(300);
    const id = await ui.input("#repoId", "chosen-id");
    id.dispatchEvent(new ui.window.Event("blur"));
    await ui.input("#commit", "123456abcdef");
    [...ui.window.document.querySelectorAll("button")].find(b => b.textContent.includes("Read-only GitHub App")).click();
    await delay(60);
    expect(ui.window.document.querySelector("#terms").value).to.equal("Private Author");
    expect(ui.window.document.querySelector("#repoId").value).to.equal("chosen-id");
    expect(ui.window.document.querySelector("#commit").value).to.equal("123456abcdef");
    expect(ui.errors).to.deep.equal([]);
  });

  for (const type of ["repo", "pr", "gist"]) {
    it(`restores unsaved ${type} edits after granting GitHub access`, async () => {
      const route = { repo: "anonymize", pr: "pull-request-anonymize", gist: "gist-anonymize" }[type];
      const source = { repo: { fullName: "owner/repo", branch: "main", commit: "123456abcdef" },
        pr: { repositoryFullName: "owner/repo", pullRequestId: 1 }, gist: { gistId: "311fc9" } }[type];
      const sourceUrl = { repo: "https://github.com/owner/repo", pr: "https://github.com/owner/repo/pull/1", gist: "https://gist.github.com/311fc9" }[type];
      const routePath = `/${route}/test`;
      ui = await browser(routePath, {
        [`/api/${type}/test`]: { status: "ready", source, options: { terms: ["persisted"], update: false } },
        "/api/repo/owner/repo/": { defaultBranch: "main" },
        "/api/repo/owner/repo/branches": [{ name: "main", commit: "abcdef123" }],
        "/api/repo/owner/repo/readme": "",
        "/api/pr/owner/repo/1": { pullRequest: { title: "Test", body: "", comments: [] } },
        "/api/gist/source/311fc9": { files: [], comments: [] },
      }, { "github-access-draft": { path: routePath, savedAt: Date.now(), draft: {
        sourceUrl, source, terms: "unsaved redaction", options: { update: false, expirationDate: "2030-01-01" },
      } } });
      await delay(60);
      expect(ui.window.document.querySelector("#terms").value).to.equal("unsaved redaction");
      if (type === "repo") expect(ui.window.document.querySelector("#commit").value).to.equal("123456abcdef");
      expect(ui.window.sessionStorage.getItem("github-access-draft")).to.equal(null);
      expect(ui.errors).to.deep.equal([]);
    });
  }

  for (const type of ["gist", "pr", "repo"]) {
    for (const status of ["removed", "expired", "error", "ready"]) {
      it(`submits ${status} ${type} edits and exposes invalid expiration dates`, async function () {
        const route = { gist: "gist-anonymize", pr: "pull-request-anonymize", repo: "anonymize" }[type];
        const source = { gist: { gistId: "311fc9" }, pr: { repositoryFullName: "owner/repo", pullRequestId: 1 }, repo: { fullName: "owner/repo", branch: "main", commit: "abcdef123" } }[type];
        const endpoint = `/api/${type}/test`;
        ui = await browser(`/${route}/test`, {
          [endpoint]: request => request.method === "POST" ? {} : { status, source, options: { terms: [], update: false, expirationDate: "2000-01-01" } },
          "/api/gist/source/311fc9": { files: [], comments: [] },
          "/api/pr/owner/repo/1": { pullRequest: { title: "Test", body: "", comments: [] } },
          "/api/repo/owner/repo/": { defaultBranch: "main" },
          "/api/repo/owner/repo/branches": [{ name: "main", commit: "abcdef123" }],
          "/api/repo/owner/repo/readme": "",
        });
        const button = [...ui.window.document.querySelectorAll("button")].find(b => b.textContent.includes("Update "));
        const posts = () => ui.requests.filter(r => r.method === "POST" && r.url.pathname === endpoint);
        button.click();
        await delay(10);
        expect(posts()).to.have.length(0);
        expect(ui.window.document.activeElement.id).to.equal("expirationDate");
        const future = new Date();
        future.setDate(future.getDate() + 30);
        await ui.input("#expirationDate", future.toISOString().slice(0, 10), "change");
        button.click();
        await delay(20);
        expect(posts()).to.have.length(1);
        expect(ui.window.document.querySelector("#commit") === null).to.equal(type !== "repo");
        expect(ui.errors).to.deep.equal([]);
      });
    }
  }

  for (const type of ["gist", "pr"]) {
    it(`creates a new ${type} with auto-update disabled`, async function () {
      const sourceUrl = type === "gist" ? "https://gist.github.com/311fc9" : "https://github.com/owner/repo/pull/1";
      ui = await browser("/anonymize", {
        "/api/gist/source/311fc9": { files: [], comments: [] },
        "/api/pr/owner/repo/1": { pullRequest: { title: "Test", body: "", comments: [] } },
      });
      const input = await ui.input("#sourceUrl", sourceUrl);
      input.dispatchEvent(new ui.window.Event("blur"));
      await delay(40);
      expect(ui.window.document.querySelector("#update").checked).to.equal(false);
      const button = [...ui.window.document.querySelectorAll("button[type=submit]")][0];
      button.click();
      await delay(20);
      expect(ui.requests.filter(r => r.method === "POST" && r.url.pathname === `/api/${type}/`)).to.have.length(1);
      expect(ui.errors).to.deep.equal([]);
    });
  }

  it("still rejects a missing commit for a repository with auto-update disabled", async function () {
    ui = await browser("/anonymize/test", {
      "/api/repo/test": { source: { fullName: "owner/repo", branch: "main", commit: "abcdef123" }, options: { terms: [], update: false } },
      "/api/repo/owner/repo/": { defaultBranch: "main" },
      "/api/repo/owner/repo/branches": [{ name: "main", commit: "abcdef123" }],
      "/api/repo/owner/repo/readme": "",
    });
    await ui.input("#commit", "");
    ui.window.document.querySelector("button[type=submit]").click();
    expect(ui.requests.filter(r => r.method === "POST" && r.url.pathname === "/api/repo/test")).to.have.length(0);
    expect(ui.window.document.activeElement.id).to.equal("commit");
  });

  it("loads document libraries on demand and reuses them across navigation", async function () {
    ui = await browser("/dashboard");
    expect(ui.assets.filter(url => url.endsWith(".js"))).to.deep.equal([]);
    await ui.go("/r/test/README.md");
    expect(ui.assets.some(url => /\/markdown\./.test(url))).to.equal(true);
    expect(ui.assets.some(url => /\/(pdf|editor|notebook)\./.test(url))).to.equal(false);
    await ui.go("/faq");
    await ui.go("/r/test/README.md");
    expect(ui.assets.filter(url => /\/markdown\./.test(url))).to.have.length(1);
    await ui.go("/r/test/hello.js");
    expect(ui.assets.some(url => /\/editor\./.test(url))).to.equal(true);
    expect(ui.window.document.querySelector(".ace_editor")).not.to.equal(null);
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
    ui.window.pdfjsLib = { GlobalWorkerOptions: {}, getDocument({ url }) {
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
