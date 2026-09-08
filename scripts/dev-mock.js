/**
 * Mock server for local UI work on authenticated pages (dashboard, etc.).
 *
 * Serves the local `public/` folder exactly like scripts/dev-proxy.js, but
 * instead of proxying the API to the live site it answers the user-facing
 * endpoints with fixture data. No database, no GitHub login required.
 *
 *   node scripts/dev-mock.js          # default port 4002
 *   PORT=5000 node scripts/dev-mock.js
 *
 * The fixtures deliberately include awkward records (expired, error,
 * stuck download, legacy record without an id, conference tag, unlimited
 * quota) so the dashboard's edge cases can be checked visually.
 */

const path = require("path");
const fs = require("fs");
const express = require("express");

const PORT = parseInt(process.env.PORT || "4002", 10);
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const manifestPath = path.join(PUBLIC_DIR, "asset-manifest.json");

function asset(name) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    return manifest[name] || name;
  } catch {
    return name;
  }
}

function indexHtml() {
  return fs
    .readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf-8")
    .replace("__CORE_JS__", asset("core.min.js"))
    .replace("__VENDOR_JS__", asset("vendor.min.js"))
    .replace("__MERMAID_JS__", asset("mermaid.min.js"))
    .replace("__ALL_CSS__", asset("all.min.css"));
}

// ---- Fixtures --------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const ahead = (days) => new Date(Date.now() + days * DAY).toISOString();

const opts = (extra) =>
  Object.assign(
    { terms: [], expirationMode: "never", update: false, page: false },
    extra || {}
  );

const repositories = [
  {
    repoId: "anonymous_github-C72C",
    status: "ready",
    anonymizeDate: ago(3),
    lastView: ago(1),
    pageView: 15,
    conference: "FSE25",
    source: { fullName: "tdurieux/anonymous_github", branch: "main", commit: "c40da900ab12" },
    options: opts({ expirationMode: "redirect", expirationDate: ahead(420), update: true, page: true }),
  },
  {
    repoId: "840c8c57-3c32-451e-bf12-0e20be300389",
    status: "ready",
    anonymizeDate: ago(120),
    lastView: ago(0.2),
    pageView: 596460,
    source: { fullName: "tdurieux/anonymous_github", branch: "main", commit: "f817a29a0000" },
    options: opts({ update: true }),
  },
  {
    repoId: "JarSift",
    status: "expired",
    anonymizeDate: ago(560),
    lastView: ago(30),
    pageView: 72,
    conference: "FSE25",
    source: { fullName: "Cornul11/JarSift", commit: "035adc67ffff" },
    options: opts({ expirationMode: "remove", expirationDate: ago(9) }),
  },
  {
    repoId: "b4751b8e-6139-4a94-84f8-646106435809",
    status: "error",
    statusMessage: "branch_not_found",
    anonymizeDate: ago(1990),
    pageView: 0,
    source: { fullName: "tdurieux/anonymous_github", branch: "master", commit: "a5b0c7c3aaaa" },
    options: opts({ update: true }),
  },
  {
    repoId: "runtime-repair-experiments-very-long-identifier-2ff4",
    status: "ready",
    anonymizeDate: ago(40),
    pageView: 5,
    conference: "International Conference on Software Engineering 2026 Artifact Track",
    source: { fullName: "Spirals-Team/runtime-repair-experiments", branch: "master", commit: "2ff4cdef1234" },
    options: opts({ expirationMode: "remove", expirationDate: ahead(1) , update: true }),
  },
  {
    repoId: "coauthored-repo-91AB",
    status: "ready",
    role: "coauthor",
    anonymizeDate: ago(12),
    pageView: 41,
    source: { fullName: "someone-else/paper-artifact", commit: "b5ab2e21dddd" },
    options: opts(),
  },
];

const pullRequests = [
  {
    pullRequestId: "5774",
    status: "ready",
    anonymizeDate: ago(2),
    lastView: ago(2),
    pageView: 9,
    source: { repositoryFullName: "vyperlang/vyper", pullRequestId: 3224 },
    options: opts(),
  },
  {
    pullRequestId: "436B",
    status: "download",
    anonymizeDate: ago(126),
    pageView: 12,
    source: { repositoryFullName: "lncapital/torq", pullRequestId: 307 },
    options: opts(),
  },
  {
    pullRequestId: "7CF7",
    status: "preparing",
    anonymizeDate: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    pageView: 0,
    source: { repositoryFullName: "Tiledesk/tiledesk-server", pullRequestId: 89 },
    options: opts(),
  },
  {
    // Legacy record without an identifier or options.
    status: "ready",
    pageView: 0,
    source: { repositoryFullName: "atmoz/sftp", pullRequestId: 357 },
  },
  {
    pullRequestId: "demo-pr",
    status: "removed",
    anonymizeDate: ago(1030),
    pageView: 319,
    source: { repositoryFullName: "tdurieux/anonymous_github", pullRequestId: 156 },
    options: opts(),
  },
];

const gists = [
  {
    gistId: "g-4f2a",
    status: "ready",
    anonymizeDate: ago(6),
    pageView: 3,
    source: { gistId: "a1b2c3d4e5f6a7b8c9d0" },
    options: opts({ expirationMode: "remove", expirationDate: ahead(90) }),
  },
];

const quota = {
  storage: { used: 5.6 * 1024 * 1024, total: 2 * 1024 * 1024 * 1024 },
  file: { used: 1381, total: 0 },
  repository: { used: 17, total: 20 },
};

// ---- Server ----------------------------------------------------------------

const app = express();

app.get(/^\/(script|css)\/(.+)\.([a-f0-9]{10})\.(min\.\w+|\w+)$/, (req, res, next) => {
  const filePath = path.join(PUBLIC_DIR, req.params[0], `${req.params[1]}.${req.params[3]}`);
  if (!fs.existsSync(filePath)) return next();
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(filePath);
});

app.get("/api/user", (req, res) => res.json({ username: "tdurieux", photo: "", isAdmin: false }));
app.get("/api/options", (req, res) => res.json({}));
app.get("/api/message", (req, res) => res.status(404).end());
app.get("/api/user/quota", (req, res) => res.json(quota));
app.get("/api/user/anonymized_repositories", (req, res) => res.json(repositories));
app.get("/api/user/anonymized_pull_requests", (req, res) => res.json(pullRequests));
app.get("/api/user/anonymized_gists", (req, res) => res.json(gists));
app.get("/api/user/default", (req, res) => res.json({}));
app.all("/api/{*rest}", (req, res) => res.status(404).json({ error: "not mocked: " + req.path }));

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  next();
});
app.use(express.static(PUBLIC_DIR, { etag: false, cacheControl: false }));
app.get("/{*rest}", (req, res) => res.type("html").send(indexHtml()));

app.listen(PORT, () => {
  console.log(`mock ui  http://localhost:${PORT}/dashboard`);
});
