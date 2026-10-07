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
  // Exercise the production bundle on browsers without this ES2022 builtin.
  window.Object.hasOwn = undefined;
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

  const repositorySource = {
    "/api/user": { username: "owner" },
    "/api/user/default": { terms: ["Default Author"], options: {} },
    "/api/repo/owner/repo/": { defaultBranch: "main", repo: "repo", hasPage: false },
    "/api/repo/owner/repo/branches": [{ name: "main", commit: "abcdef123" }],
    "/api/repo/owner/repo/readme": "# Private Author",
    "/api/anonymize-preview": request => ({ content: request.payload.content.replaceAll("Private Author", "MASKED") }),
  };

  it("keeps the current repository when earlier metadata and README responses arrive late", async () => {
    let finishMetadata, finishReadme;
    ui = await browser("/anonymize", {
      ...repositorySource,
      "/api/repo/owner/old/": () => new Promise(resolve => { finishMetadata = () => resolve({ repo: "old", id: "old-id", defaultBranch: "old-main", hasPage: true }); }),
      "/api/repo/owner/old/readme": () => new Promise(resolve => { finishReadme = () => resolve("OLD PRIVATE README"); }),
      "/api/repo/owner/repo/": { repo: "repo", id: "new-id", defaultBranch: "main", hasPage: false },
      "/api/anonymize-preview": request => ({ content: request.payload.content }),
    });
    const state = ui.window.document.querySelector("#sourceUrl")._field.binding.state;
    state.sourceUrl = "https://github.com/owner/old";
    const oldLoad = state.urlSelected();
    await delay(10);
    state.sourceUrl = "https://github.com/owner/repo";
    await state.urlSelected();
    finishMetadata(); finishReadme(); await oldLoad;
    await delay(240);
    expect(state.details.repo).to.equal("repo");
    expect(state.repositoryID).to.equal("new-id");
    expect(state.source.branch).to.equal("main");
    expect(ui.window.document.querySelector(".anonymize-preview-body").textContent).to.include("Private Author");
    expect(ui.window.document.querySelector(".anonymize-preview-body").textContent).not.to.include("OLD PRIVATE README");
    expect(state.sourceLoading).to.equal(false);
    expect(ui.errors).to.deep.equal([]);
  });

  it("ignores old branches and source errors after changing repositories", async () => {
    let finishBranches;
    ui = await browser("/anonymize", {
      ...repositorySource,
      "/api/repo/owner/old/": { repo: "old", defaultBranch: "old-main" },
      "/api/repo/owner/old/readme": "",
      "/api/repo/owner/old/branches": () => new Promise(resolve => { finishBranches = () => resolve({ __status: 404, body: { error: "repo_not_found" } }); }),
    });
    const state = ui.window.document.querySelector("#sourceUrl")._field.binding.state;
    state.sourceUrl = "https://github.com/owner/old"; const oldLoad = state.urlSelected();
    await delay(10);
    state.sourceUrl = "https://github.com/owner/repo"; await state.urlSelected();
    finishBranches(); await oldLoad;
    expect(state.branches.map(b => b.name)).to.deep.equal(["main"]);
    expect(state.anonymize.sourceUrl.invalid).to.equal(false);
    expect(ui.errors).to.deep.equal([]);
  });

  it("reloads a source when the default GitHub connection arrives after source loading begins", async () => {
    let finishConnections, finishOldMetadata;
    ui = await browser("/anonymize", {
      ...repositorySource,
      "/github/connections": () => new Promise(resolve => { finishConnections = () => resolve({ appEnabled: true, appConnected: true }); }),
      "/api/repo/owner/repo/": request => request.url.searchParams.get("connection") === "github-app"
        ? { repo: "repo", id: "app-id", defaultBranch: "main" }
        : new Promise(resolve => { finishOldMetadata = () => resolve({ repo: "old", id: "old-id", defaultBranch: "old-main" }); }),
    });
    const state = ui.window.document.querySelector("#sourceUrl")._field.binding.state;
    state.sourceUrl = "https://github.com/owner/repo";
    const oldLoad = state.urlSelected();
    await delay(10);
    finishConnections();
    await delay(50);
    finishOldMetadata(); await oldLoad;
    expect(state.githubConnection).to.equal("github-app");
    expect(state.repositoryID).to.equal("app-id");
    expect(state.source.branch).to.equal("main");
    expect(state.sourceLoading).to.equal(false);
    expect(ui.errors).to.deep.equal([]);
  });

  for (const kind of ["pr", "gist"]) {
    it(`ignores late ${kind} metadata after switching sources`, async () => {
      let finish;
      const oldPath = kind === "pr" ? "/api/pr/owner/old/42" : "/api/gist/source/abc123";
      ui = await browser("/anonymize", { ...repositorySource, [oldPath]: () => new Promise(resolve => { finish = () => resolve(kind === "pr" ? { pullRequest: { title: "OLD PR" } } : { gist: { description: "OLD GIST" } }); }) });
      const state = ui.window.document.querySelector("#sourceUrl")._field.binding.state;
      state.sourceUrl = kind === "pr" ? "https://github.com/owner/old/pull/42" : "https://gist.github.com/abc123";
      const oldLoad = state.urlSelected(); await delay(10);
      state.sourceUrl = "https://github.com/owner/repo"; await state.urlSelected();
      finish(); await oldLoad;
      expect(state.details.repo).to.equal("repo");
      expect(state.detectedType).to.equal("repo");
      expect(ui.errors).to.deep.equal([]);
    });
  }

  it("preserves and restores edits made while defaults are saving", async () => {
    let finishSave;
    ui = await browser("/profile", { ...repositorySource, "/api/user/default": request => request.method === "POST"
      ? new Promise(resolve => { finishSave = () => resolve({}); })
      : { terms: ["Original"], options: {} } });
    await ui.input("#terms", "Submitted terms");
    ui.window.document.querySelector("#save").click(); await delay(10);
    await ui.input("#terms", "Newer unsaved terms"); await delay(270);
    finishSave(); await delay(30);
    expect(ui.window.document.querySelector("#terms").value).to.equal("Newer unsaved terms");
    expect(JSON.parse(ui.window.sessionStorage.getItem("form-draft:profile")).values.terms).to.equal("Newer unsaved terms");
    expect(ui.window.document.querySelector("#save").textContent).not.to.equal("Saved");
    await ui.go("/dashboard"); await ui.go("/profile");
    expect(ui.window.document.querySelector("#terms").value).to.equal("Newer unsaved terms");
    expect(ui.errors).to.deep.equal([]);
  });

  it("discards a restored draft and cancels pending textarea edits", async () => {
    ui = await browser("/profile", repositorySource, { "form-draft:profile": { account: "owner", savedAt: Date.now(), values: { terms: "Restored draft", options: {} } } });
    await ui.input("#terms", "Pending edit");
    ui.window.document.querySelector(".draft-discard").click(); await delay(300);
    expect(ui.window.document.querySelector("#terms").value).to.equal("Default Author");
    expect(ui.window.sessionStorage.getItem("form-draft:profile")).to.equal(null);
    expect(ui.errors).to.deep.equal([]);
  });

  it("uses a readable fallback for unknown settings errors", async () => {
    ui = await browser("/profile", { ...repositorySource, "/api/user/default": request => request.method === "POST" ? { __status: 503, body: { error: "untranslated_failure" } } : { terms: [], options: {} } });
    ui.window.document.querySelector("#save").click(); await delay(30);
    expect(ui.window.document.querySelector('[role="alert"]').textContent).to.include("Unable to save your defaults");
    expect(ui.errors).to.deep.equal([]);
  });

  it("shows conference load failures and retries without a false empty state", async () => {
    let fail = true;
    ui = await browser("/conferences", { "/api/user": { username: "owner" }, "/api/conferences/": () => fail ? { __status: 503, body: { error: "unavailable" } } : [{ conferenceID: "ICSE26", name: "ICSE 2026", status: "ready" }] });
    expect(ui.window.document.body.textContent).to.include("Unable to load your conferences");
    expect(ui.window.document.body.textContent).not.to.include("You have not created a conference yet");
    fail = false; ui.window.document.querySelector(".conference-feedback button").click(); await delay(30);
    await ui.input("#search", " icse ");
    expect(ui.window.document.querySelector(".repo-name").textContent).to.equal("ICSE 2026");
    expect(ui.errors).to.deep.equal([]);
  });

  it("prevents duplicate conference saves and keeps a visible failure message", async () => {
    let finishSave;
    ui = await browser("/conference/new", { "/api/user": { username: "owner" }, "/api/conferences/": () => new Promise(resolve => { finishSave = () => resolve({ __status: 503, body: { error: "unavailable" } }); }) });
    await ui.input("#name", "Test venue"); await ui.input("#conferenceID", "TEST26");
    const button = ui.window.document.querySelector("#send"); button.click(); button.click(); await delay(10);
    expect(button.disabled).to.equal(true);
    expect(ui.requests.filter(r => r.method === "POST" && r.url.pathname === "/api/conferences/")).to.have.length(1);
    finishSave(); await delay(30);
    expect(button.disabled).to.equal(false);
    expect(ui.window.document.querySelector('[role="alert"]').textContent).to.include("Unable to save the conference");
    expect(ui.errors).to.deep.equal([]);
  });

  it("keeps an enabled PR preview selected and supports arrow-key navigation", async () => {
    ui = await browser("/pull-request-anonymize/saved", {
      ...repositorySource,
      "/api/pr/saved": { source: { repositoryFullName: "owner/repo", pullRequestId: 42 }, options: { terms: [] } },
      "/api/pr/owner/repo/42": { pullRequest: { title: "Example", diff: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new", comments: [{ author: "Reviewer", body: "Visible comment" }] } },
      "/api/anonymize-preview": request => ({ contents: request.payload.contents }),
    });
    await delay(250);
    ui.window.document.querySelector("#diff").click(); await delay(240);
    expect(ui.window.document.querySelector("#preview-pr-comments-tab").getAttribute("aria-selected")).to.equal("true");
    expect(ui.window.document.querySelector("#preview-pr-comments-panel").textContent).to.include("Visible comment");
    ui.window.document.querySelector("#diff").click(); await delay(240);
    ui.window.document.querySelector("#preview-pr-comments-tab").dispatchEvent(new ui.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); await delay(10);
    expect(ui.window.document.activeElement.id).to.equal("preview-pr-diff-tab");
    expect(ui.window.document.querySelector("#preview-pr-diff-tab").getAttribute("aria-selected")).to.equal("true");
    expect(ui.errors).to.deep.equal([]);
  });

  it("keeps focus during partial URL entry and transfers it after a valid URL", async () => {
    ui = await browser("/anonymize", repositorySource);
    const landing = ui.window.document.querySelector("#sourceUrl-landing");
    landing.focus();
    await ui.input("#sourceUrl-landing", "h");
    await delay(1050);
    expect(ui.window.document.activeElement).to.equal(landing);
    expect(ui.window.document.querySelector(".anonymize-workspace").style.display).to.equal("none");
    await ui.input("#sourceUrl-landing", "https://github.com/owner/repo");
    landing.dispatchEvent(new ui.window.Event("blur"));
    await delay(40);
    expect(ui.window.document.activeElement.id).to.equal("sourceUrl");
    expect(ui.errors).to.deep.equal([]);
  });

  it("keeps custom redactions, identifiers and commits when correcting the same source URL", async () => {
    ui = await browser("/anonymize", repositorySource);
    const source = await ui.input("#sourceUrl", "https://github.com/owner/repo");
    source.dispatchEvent(new ui.window.Event("blur"));
    await delay(40);
    await ui.input("#terms", "Private Author");
    await delay(270);
    const id = await ui.input("#repoId", "chosen-id");
    id.dispatchEvent(new ui.window.Event("blur"));
    await ui.input("#commit", "123456abcdef");
    await ui.input("#sourceUrl", "https://github.com/owner/repo/");
    source.dispatchEvent(new ui.window.Event("blur"));
    await delay(50);
    expect(ui.window.document.querySelector("#terms").value).to.equal("Private Author");
    expect(ui.window.document.querySelector("#repoId").value).to.equal("chosen-id");
    expect(ui.window.document.querySelector("#commit").value).to.equal("123456abcdef");
    expect(ui.window.document.querySelector(".anonymize-form-col").textContent).not.to.include("Switch the branch above");
    expect(ui.errors).to.deep.equal([]);
  });

  for (const kind of ["repo", "pr", "gist"]) {
    it(`hides original ${kind} content after a preview failure and supports retry`, async () => {
      let fail = true;
      const route = { repo: "/anonymize/saved", pr: "/pull-request-anonymize/saved", gist: "/gist-anonymize/saved" }[kind];
      const fixtures = {
        ...repositorySource,
        "/api/repo/saved": { source: { fullName: "owner/repo", branch: "main", commit: "abcdef123" }, options: { terms: ["Private Author"] } },
        "/api/pr/saved": { source: { repositoryFullName: "owner/repo", pullRequestId: 42 }, options: { terms: ["Private Author"] } },
        "/api/pr/owner/repo/42": { pullRequest: { title: "Private Author", body: "Private Author body", comments: [] } },
        "/api/gist/saved": { source: { gistId: "abc123" }, options: { terms: ["Private Author"] } },
        "/api/gist/source/abc123": { gist: { description: "Private Author", files: [{ filename: "code.txt", content: "Private Author" }], comments: [] } },
        "/api/anonymize-preview": request => {
          if (fail) return { __status: 503, body: { error: "unavailable" } };
          const mask = value => value.replaceAll("Private Author", "MASKED");
          return request.payload.contents ? { contents: request.payload.contents.map(mask) } : { content: mask(request.payload.content) };
        },
      };
      ui = await browser(route, fixtures);
      await delay(280);
      const preview = () => ui.window.document.querySelector(".anonymize-preview-col");
      expect(preview().textContent).to.include("Unable to generate");
      expect(preview().textContent).not.to.include("Private Author");
      expect(preview().textContent).not.to.include("redactions applied");
      fail = false;
      [...preview().querySelectorAll("button")].find(b => b.textContent === "Retry preview").click();
      await delay(260);
      expect(preview().textContent).to.include("MASKED");
      expect(preview().textContent).to.include("redactions applied");
      expect(ui.errors).to.deep.equal([]);
    });
  }

  it("ignores an old preview response while new redactions are waiting for the debounce", async () => {
    let finishOld;
    let count = 0;
    ui = await browser("/pull-request-anonymize/saved", {
      "/api/user": { username: "owner" },
      "/api/pr/saved": { source: { repositoryFullName: "owner/repo", pullRequestId: 42 }, options: { terms: ["Alice"] } },
      "/api/pr/owner/repo/42": { pullRequest: { title: "Alice", comments: [] } },
      "/api/anonymize-preview": () => ++count === 1
        ? new Promise(resolve => { finishOld = () => resolve({ contents: ["OLD PREVIEW"] }); })
        : { contents: ["LATEST PREVIEW"] },
    });
    await delay(240);
    await ui.input("#terms", "Bob");
    await delay(270);
    finishOld();
    await delay(20);
    const preview = () => ui.window.document.querySelector(".anonymize-preview-col").textContent;
    expect(preview()).not.to.include("OLD PREVIEW");
    expect(preview()).to.include("Updating");
    await delay(230);
    expect(preview()).to.include("LATEST PREVIEW");
    expect(ui.errors).to.deep.equal([]);
  });

  it("submits billing details for a new paid conference", async () => {
    ui = await browser("/conference/new", {
      "/api/user": { username: "owner" },
      "/api/conferences/plans": [{ id: "free_conference", name: "Free", pricePerRepo: 0 }, { id: "premium_conference", name: "Premium", pricePerRepo: 0.5 }],
    });
    await ui.input("#name", "Review venue");
    await ui.input("#conferenceID", "REVIEW26");
    ui.window.document.querySelector('input[value="premium_conference"]').click();
    await delay(20);
    for (const [id, value] of Object.entries({ billing_name: "Jane Smith", email: "jane@example.org", inputAddress: "12 Main St", city: "Paris", country: "France", zip: "75001" })) await ui.input("#" + id, value);
    expect(ui.window.document.querySelector("#billing_name").value).to.equal("Jane Smith");
    ui.window.document.querySelector("#send").click();
    await delay(30);
    const request = ui.requests.find(r => r.method === "POST" && r.url.pathname === "/api/conferences/");
    expect(request?.payload.billing).to.include({ name: "Jane Smith", email: "jane@example.org", city: "Paris" });
    expect(ui.errors).to.deep.equal([]);
  });

  it("opens FAQ fragments on direct load and subsequent navigation", async () => {
    ui = await browser("/faq#formats");
    await delay(370);
    expect(ui.window.document.querySelector("#formats").classList.contains("show")).to.equal(true);
    expect(ui.window.document.activeElement.id).to.equal("headingFormats");
    await ui.go("/faq#permissions");
    await delay(370);
    expect(ui.window.document.querySelector("#permissions").classList.contains("show")).to.equal(true);
    expect(ui.window.document.activeElement.id).to.equal("headingPermissions");
    expect(ui.errors).to.deep.equal([]);
  });

  for (const page of ["profile", "anonymize"]) {
    it(`restores unsaved ${page} redactions after navigation`, async () => {
      ui = await browser("/" + page, repositorySource);
      await ui.input("#terms", "Unsaved Author");
      // Leaving must flush the pending textarea debounce into the draft.
      await ui.go("/dashboard");
      await ui.go("/" + page);
      await delay(40);
      expect(ui.window.document.querySelector("#terms").value).to.equal("Unsaved Author");
      expect(ui.window.document.querySelector(".draft-status").textContent).to.include("restored");
      expect(ui.errors).to.deep.equal([]);
    });
  }

  it("does not restore another account's draft", async () => {
    ui = await browser("/profile", { "/api/user": { username: "owner" } }, {
      "form-draft:profile": { account: "someone-else", savedAt: Date.now(), values: { terms: "Other account", options: {} } },
    });
    expect(ui.window.document.querySelector("#terms").value).not.to.equal("Other account");
    expect(ui.errors).to.deep.equal([]);
  });

  it("copies the anonymous URL and reports a clipboard failure without claiming success", async () => {
    ui = await browser("/dashboard", {
      "/api/user": { username: "owner" },
      "/api/user/anonymized_repositories": [{ repoId: "share-me", status: "ready", source: { fullName: "owner/private" }, options: {} }],
    });
    const copied = [];
    ui.window.navigator.clipboard = { writeText: async value => copied.push(value) };
    const button = [...ui.window.document.querySelectorAll("button")].find(b => b.textContent.includes("Copy anonymous link"));
    button.click();
    await delay(20);
    expect(copied).to.deep.equal(["http://localhost/r/share-me/"]);
    expect(ui.app.state.toasts[0].title).to.equal("Link copied");
    ui.window.navigator.clipboard.writeText = async () => { throw Error("Denied"); };
    button.click();
    await delay(20);
    expect(ui.app.state.toasts.at(-1).title).to.equal("Copy this anonymous link");
    expect(ui.app.state.toasts.at(-1).body).to.equal("http://localhost/r/share-me/");
    expect(ui.errors).to.deep.equal([]);
  });

  for (const path of [
    "/r/submission-artifact-604F/",
    "/r/submission-artifact-604F",
    "/r/submission-artifact-604F/src/hello%20world.js?raw=1&value=a%2Fb#L12",
  ]) {
    it(`opens a legacy hashbang repository link at ${path}`, async function () {
      ui = await browser("/#!" + path);
      expect(ui.app.router.currentRoute.value.fullPath).to.equal(path);
      expect(ui.app.router.currentRoute.value.params.repoId).to.equal("submission-artifact-604F");
      expect(ui.window.location.href).to.equal("http://localhost" + path);
      expect(ui.window.history.length).to.equal(1);
      expect(ui.requests.some(request => request.url.pathname.startsWith("/api/repo/submission-artifact-604F/"))).to.equal(true);
      expect(ui.errors).to.deep.equal([]);
    });
  }

  for (const path of ["/r/test/#L12", "/#ordinary-anchor", "/#!//example.com/r/test/"]) {
    it(`leaves a nonlegacy URL unchanged: ${path}`, async function () {
      ui = await browser(path);
      expect(ui.window.location.href).to.equal("http://localhost" + path);
      expect(ui.app.router.currentRoute.value.fullPath).to.equal(path);
      expect(ui.errors).to.deep.equal([]);
    });
  }

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

  it("offers one App sign-in for new and existing accounts", async function () {
    ui = await browser("/signin", { "/api/options": { GITHUB_APP_ENABLED: true, GITHUB_OAUTH_ENABLED: true } });
    expect(ui.window.document.querySelector('a[href="/github/app/login"]')).not.to.equal(null);
    expect(ui.window.document.querySelector('a[href="/github/login"]')).to.equal(null);
    expect(ui.errors).to.deep.equal([]);
  });

  it("shows previous-connection verification only for a pending recovery", async function () {
    ui = await browser("/signin?recover=1", {
      "/api/options": { GITHUB_APP_ENABLED: true, GITHUB_OAUTH_ENABLED: true },
      "/github/account-recovery": { required: true },
    });
    expect(ui.window.document.querySelector('a[href="/github/login?recover=1"]')).not.to.equal(null);
    expect(ui.window.document.querySelector('a[href="/github/app/login"]')).to.equal(null);
    expect(ui.errors).to.deep.equal([]);
  });

  it("falls back to one OAuth sign-in when the App is disabled", async function () {
    ui = await browser("/signin", { "/api/options": { GITHUB_APP_ENABLED: false, GITHUB_OAUTH_ENABLED: true } });
    expect(ui.window.document.querySelector('a[href="/github/login"]')).not.to.equal(null);
    expect(ui.window.document.querySelector('a[href="/github/app/login"]')).to.equal(null);
  });

  it("offers OAuth for an App-only gist and saves the draft before connecting", async function () {
    ui = await browser("/gist-anonymize", {
      "/api/user": { username: "owner" },
      "/github/connections": { appEnabled: true, appConnected: true, oauthEnabled: true, oauthConnected: false },
    });
    const input = await ui.input("#sourceUrl", "https://gist.github.com/311fc9");
    input.dispatchEvent(new ui.window.Event("blur"));
    await delay(60);
    const button = [...ui.window.document.querySelectorAll("button")].find(node => node.textContent.includes("Connect GitHub OAuth to access gists"));
    expect(button).not.to.equal(undefined);
    expect(ui.requests.some(r => r.url.pathname === "/api/gist/source/311fc9")).to.equal(false);
    button.click();
    const saved = JSON.parse(ui.window.sessionStorage.getItem("github-access-draft"));
    expect(saved.path).to.equal("/gist-anonymize");
    expect(saved.draft.sourceUrl).to.equal("https://gist.github.com/311fc9");
    expect(ui.errors).to.deep.equal([]);
  });

  for (const status of ["archived", "preparing", "queue", "download", "removing", "expiring"]) {
  it(`hides connection changes on ${status} resources`, async function () {
    ui = await browser("/connections", {
      "/github/connections": { appEnabled: true, appConnected: true, oauthConnected: true,
        resources: [{ type: "repository", id: "archived", connection: "github-app", status, eligible: true }] },
    });
    const resource = ui.window.document.querySelector(".connection-resource");
    expect(resource).not.to.equal(null);
    expect(resource.querySelectorAll("button")).to.have.length(0);
    expect(ui.errors).to.deep.equal([]);
  });

  }

  for (const age of [0, 6 * 60 * 1000]) {
    it("allows reconnect only for stale pull-request downloads: " + age, async function () {
      ui = await browser("/connections", {
        "/github/connections": { appEnabled: true, appConnected: true, resources: [
          { type: "pull-request", id: "stale", connection: "github-app", status: "download", statusDate: new Date(Date.now() - age).toISOString() },
        ] },
      });
      expect(ui.window.document.querySelector(".connection-resource-actions") !== null).to.equal(age > 0);
      expect(ui.errors).to.deep.equal([]);
    });
  }
  for (const connection of ["oauth", "github-app"]) {
  it(`previews and saves ${connection} access with CSRF protection`, async function () {
    const action = connection === "github-app" ? "Reconnect read-only access" : "Switch to read-only access";
    const resource = { type: "repository", id: "saved", name: "owner/private", connection, status: "ready" };
    ui = await browser("/connections", {
      "/api/user": { username: "owner" },
      "/github/connections": { csrf: "csrf-value", appEnabled: true, appConnected: true, oauthEnabled: true, oauthConnected: connection === "oauth",
        installations: [{ id: 4, account: "owner" }], gistCount: 0, resources: [resource] },
      "/github/connections/migrate": request => request.payload.preview ? { eligible: true } : { connection: "github-app" },
    });
    const button = label => [...ui.window.document.querySelectorAll("button")].find(node => node.textContent.includes(label));
    expect(button(action)).to.equal(undefined);
    expect(ui.window.document.querySelector('a[href="/github/app/install?installationId=4"]')).not.to.equal(null);
    button("Check read-only access").click();
    await delay(30);
    button(action).click();
    await delay(30);
    const changes = ui.requests.filter(r => r.url.pathname === "/github/connections/migrate");
    expect(changes).to.have.length(2);
    expect(changes[0].payload.preview).to.equal(true);
    expect(changes[1].payload.preview).to.equal(false);
    expect(changes[1].payload.connection).to.equal("github-app");
    expect(changes[1].headers["X-CSRF-Token"]).to.equal("csrf-value");
    expect(ui.errors).to.deep.equal([]);
  });
  }


  for (const [appConnected, oauthConnected] of [[true, false], [false, true], [false, false], [true, true]]) {
    it(`shows the access chooser only for two connections: ${appConnected}/${oauthConnected}`, async () => {
      ui = await browser("/anonymize", { "/github/connections": { appEnabled: true, appConnected, oauthConnected } });
      expect(Boolean(ui.window.document.querySelector(".repo-access"))).to.equal(appConnected && oauthConnected);
      expect(ui.errors).to.deep.equal([]);
    });
  }

  it("selects the connected GitHub App by default beside the source URL", async () => {
    ui = await browser("/anonymize", { "/github/connections": { appEnabled: true, appConnected: true, oauthConnected: true } });
    const panel = ui.window.document.querySelector(".anonymize-landing-inner .repo-access");
    expect(panel).not.to.equal(null);
    expect(panel.querySelector('button[aria-pressed="true"]').textContent).to.include("Read-only GitHub App");
    [...panel.querySelectorAll("button")].find(b => b.textContent.includes("Legacy OAuth")).click();
    await delay(30);
    expect(panel.querySelector('button[aria-pressed="true"]').textContent).to.include("Legacy OAuth");
    expect(ui.errors).to.deep.equal([]);
  });

  it("preserves redactions, identifiers and pinned commits when switching connections", async () => {
    ui = await browser("/anonymize", {
      "/github/connections": { appEnabled: true, appConnected: true, oauthConnected: true },
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

  it("reconnects a recreated source without saving until the owner submits", async function () {
    const oldCommit = "deadbeef";
    const newCommit = "1a212f1deb74b123804ec90d098c0f843c30da5b";
    const requireReconnect = data => request => request.url.searchParams.get("reconnect") === "1"
      ? data : { __status: 404, body: { error: "repo_not_found" } };
    ui = await browser("/anonymize/test", {
      "/api/repo/test": request => request.method === "POST" ? { status: "preparing" } : {
        connection: "github-app", role: "owner",
        source: { fullName: "owner/repo", repositoryID: "old-record", branch: "main", commit: oldCommit },
        options: { terms: ["author"], update: false, expirationMode: "never" },
      },
      "/api/repo/owner/repo/": requireReconnect({ id: "new-record", externalId: "gh_1396237353", defaultBranch: "main" }),
      "/api/repo/owner/repo/branches": requireReconnect([{ name: "main", commit: newCommit }]),
      "/api/repo/owner/repo/readme": requireReconnect("replacement readme"),
    });
    const button = [...ui.window.document.querySelectorAll("button")].find(b => b.textContent === "Reconnect source repository");
    expect(button).not.to.equal(undefined);
    const before = ui.requests.length;
    ui.window.confirm = () => false;
    button.click();
    await delay(20);
    expect(ui.requests.length).to.equal(before);
    ui.window.confirm = () => true;
    button.click();
    await delay(100);
    const previews = ui.requests.filter(r => r.url.searchParams.get("reconnect") === "1");
    expect(previews.some(r => r.url.pathname.endsWith("/branches"))).to.equal(true);
    for (const request of previews) {
      expect(request.url.searchParams.get("anonymizedRepoId")).to.equal("test");
      expect(request.url.searchParams.has("repositoryID")).to.equal(false);
    }
    expect(ui.window.document.querySelector("#commit").value).to.equal(newCommit);
    expect(ui.requests.filter(r => r.method === "POST" && r.url.pathname === "/api/repo/test")).to.have.length(0);
    ui.window.document.querySelector("button[type=submit]").click();
    await delay(30);
    const save = ui.requests.find(r => r.method === "POST" && r.url.pathname === "/api/repo/test");
    expect(save?.payload.reconnectRepositoryId).to.equal("gh_1396237353");
    expect(save.payload.source.commit).to.equal(newCommit);
    expect(save.payload.terms).to.deep.equal(["author"]);
  });

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

  for (const [file, mode] of [["data.csv", "text"], ["LICENSE", "text"], ["model.idp", "text"], ["hello.js", "javascript"], ...["csp", "applescript", "logtalk", "redshift", "sparql", "turtle"].map(mode => ["file." + mode, mode])]) {
    it("uses an available editor mode for " + file, async function () {
      ui = await browser("/r/test/" + file, {
        "/api/repo/test/files/": [{ name: file, path: "", sha: "1", size: 5 }],
      });
      await delay(80);
      const host = ui.window.document.querySelector(".ace_editor");
      expect(host).not.to.equal(null);
      expect(ui.window.ace.edit(host).session.getMode().$id).to.equal("ace/mode/" + mode);
      expect(ui.errors).to.deep.equal([]);
      expect(ui.assets.some(url => /mode-(csv|license|idp)\.js/.test(url))).to.equal(false);
    });
  }

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

  it("distinguishes source, settings and readiness dates in the explorer", async function () {
    ui = await browser("/r/test/hello.txt", {
      "/api/repo/test/options": { anonymizedAt: "2026-01-01T00:00:00Z", sourceCommitDate: "2020-01-01T00:00:00Z",
        settingsSavedAt: "2026-02-01T00:00:00Z", publishedAt: "2026-03-01T00:00:00Z" },
    });
    const footer = ui.window.document.querySelector(".leftCol-foot");
    expect(footer.textContent).to.include("Source commit").and.include("Settings saved").and.include("Snapshot ready");
    expect([...footer.querySelectorAll(".last-update")].map(node => node.title)).to.deep.equal([
      "2020-01-01T00:00:00Z", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z",
    ]);
    expect(footer.textContent).not.to.include("not recorded");
    expect(ui.errors).to.deep.equal([]);
  });
  it("identifies an unknown legacy publication date", async function () {
    ui = await browser("/r/test/hello.txt", {
      "/api/repo/test/options": { anonymizedAt: "2026-01-01T00:00:00Z", sourceCommitDate: "2020-01-01T00:00:00Z" },
    });
    const footer = ui.window.document.querySelector(".leftCol-foot");
    expect(footer.textContent).to.include("Snapshot ready date not recorded");
    expect(footer.textContent).not.to.include("Settings saved");
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

  it("shows quota limits accessibly and dismisses usage with Escape or an outside click", async () => {
    ui = await browser("/dashboard", {
      "/api/user": { username: "tester" },
      "/api/user/quota": {
        repository: { used: 21, total: 20 },
        storage: { used: 0, total: 1024 },
        file: { used: 1381, total: 0 },
      },
    });
    const doc = ui.window.document;
    const details = doc.querySelector(".dashboard-quota");
    const summary = details.querySelector("summary");
    summary.click();
    await delay(20);
    expect(details.open).to.equal(true);
    const bars = [...details.querySelectorAll('[role="progressbar"]')];
    expect(bars).to.have.length(2);
    expect(bars[0].getAttribute("aria-valuenow")).to.equal("20");
    expect(bars[0].getAttribute("aria-valuemax")).to.equal("20");
    expect(bars[1].getAttribute("aria-valuenow")).to.equal("0");
    expect(details.textContent).to.include("Limit exceeded").and.include("Unlimited");
    doc.querySelector('[aria-label="Close usage"]').focus();
    doc.activeElement.dispatchEvent(new ui.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await delay(20);
    expect(details.open).to.equal(false);
    expect(doc.activeElement).to.equal(summary);
    summary.click();
    await delay(20);
    doc.querySelector("#search").click();
    await delay(20);
    expect(details.open).to.equal(false);
    expect(summary.getAttribute("aria-expanded")).to.equal("false");
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

  it("finds errors and stalled downloads without treating fresh queued projects as failures", async () => {
    ui = await browser("/dashboard", {
      "/api/user": { username: "tester" },
      "/api/user/anonymized_repositories": [
        { repoId: "ready", status: "ready", source: { fullName: "owner/ready" } },
        { repoId: "error", status: "error", statusMessage: "branch_not_found", source: { fullName: "owner/error" } },
        { repoId: "fresh", status: "queue", anonymizeDate: new Date().toISOString(), source: { fullName: "owner/fresh" } },
        { repoId: "stalled", status: "download", anonymizeDate: "2000-01-01T00:00:00Z", source: { fullName: "owner/stalled" } },
      ],
    });
    const state = ui.window.document.querySelector("#search")._field.binding.state;
    expect(state.attentionCount()).to.equal(2);
    state.filters.status.error = false;
    state.setProjectView("attention");
    await delay(10);
    expect(state.filteredItems.map(item => item._id).sort()).to.deep.equal(["error", "stalled"]);
    expect(ui.window.document.querySelector('[href="/anonymize/error"]').textContent).to.equal("Fix source");
    expect(ui.window.document.querySelector(".filter-chip")?.textContent).not.to.include("Error hidden");
    await ui.input("#search", "stalled");
    expect(state.filteredItems).to.have.length(1);
    state.clearFilters(); await delay(10);
    expect(state.filteredItems).to.have.length(4);
    expect(ui.errors).to.deep.equal([]);
  });

  it("saves private project names and can search them after returning to the dashboard", async () => {
    const gist = { gistId: "g-demo", status: "ready", source: { gistId: "a1b2c3d4e5" } };
    let payload;
    ui = await browser("/dashboard", {
      "/api/user": { username: "tester" },
      "/api/user/anonymized_gists": () => [gist],
      "/api/user/project-name": request => { payload = request.payload; gist.projectName = payload.name; return { name: payload.name }; },
    });
    const state = ui.window.document.querySelector("#search")._field.binding.state;
    expect(state.items[0]._label).to.equal("Gist g-demo");
    await state.showProjectDetails(state.items[0]);
    await ui.input("#project-name-gist-g-demo", "Training utilities");
    ui.window.document.querySelector(".project-name-form").dispatchEvent(new ui.window.Event("submit", { bubbles: true, cancelable: true }));
    await delay(20);
    expect(payload).to.deep.equal({ type: "gist", id: "g-demo", name: "Training utilities" });
    expect(ui.window.document.querySelector(".repo-name").textContent).to.equal("Training utilities");
    await ui.go("/faq"); await ui.go("/dashboard");
    await ui.input("#search", " training ");
    expect(ui.window.document.querySelectorAll(".paper-table-row:not(.paper-table-skeleton)")).to.have.length(1);
    expect(ui.window.document.querySelector(".repo-name").textContent).to.equal("Training utilities");
    expect(ui.errors).to.deep.equal([]);
  });

  it("keeps the current project name visible when saving a replacement fails", async () => {
    let complete;
    ui = await browser("/dashboard", {
      "/api/user": { username: "tester" },
      "/api/user/anonymized_repositories": [{ repoId: "package", status: "ready", projectName: "Saved package", source: { fullName: "owner/package" } }],
      "/api/user/project-name": () => new Promise(resolve => { complete = () => resolve({ __status: 503, body: { error: "unavailable" } }); }),
    });
    const state = ui.window.document.querySelector("#search")._field.binding.state;
    const item = state.items[0];
    await state.showProjectDetails(item);
    state.projectName = "Replacement";
    const pending = state.saveProjectName(item);
    await state.saveProjectName(item);
    expect(ui.requests.filter(r => r.url.pathname === "/api/user/project-name")).to.have.length(1);
    complete(); await pending; await delay(10);
    expect(item._label).to.equal("Saved package");
    expect(ui.window.document.querySelector(".project-name-error").textContent).to.include("could not be saved");
    expect(ui.errors).to.deep.equal([]);
  });

  it("shows full project details as text and restores keyboard focus when closed", async () => {
    const source = "owner/" + "very-long-project-name-".repeat(5);
    ui = await browser("/dashboard", {
      "/api/user": { username: "tester" },
      "/api/user/anonymized_repositories": [{ repoId: "package", status: "ready", projectName: '<img src=x onerror="alert(1)">', source: { fullName: source, commit: "abcdef1234567890" }, conference: "A long conference name" }],
    });
    const state = ui.window.document.querySelector("#search")._field.binding.state;
    await state.showProjectDetails(state.items[0]);
    const panel = ui.window.document.querySelector(".project-details");
    expect(panel.textContent).to.include(source).and.include("abcdef1234567890").and.include("A long conference name");
    expect(ui.window.document.querySelector(".repo-name img")).to.equal(null);
    expect(ui.window.document.activeElement).to.equal(panel);
    panel.dispatchEvent(new ui.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await delay(10);
    expect(ui.window.document.querySelector(".project-details")).to.equal(null);
    expect(ui.window.document.activeElement.getAttribute("data-project-actions")).to.equal("repo%3Apackage");
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
