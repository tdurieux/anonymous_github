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

const conferences = [
  {
    conferenceID: "FSE25",
    name: "Foundations of Software Engineering 2025",
    url: "https://conf.researchr.org/home/fse-2025",
    startDate: ago(400),
    endDate: ahead(30),
    status: "ready",
    options: opts({ page: true }),
    plan: { planID: "premium_conference", name: "Premium", pricePerRepository: 0.5 },
    price: 12.5,
    nbRepositories: 2,
    repositories: repositories.slice(0, 4).map((r) => Object.assign({}, r, { addDate: ago(60) })),
  },
  {
    conferenceID: "ICSE26-AE",
    name: "ICSE 2026 Artifact Evaluation",
    url: "https://conf.researchr.org/home/icse-2026",
    startDate: ahead(10),
    endDate: ahead(120),
    status: "ready",
    options: opts(),
    plan: { planID: "free_conference", name: "Free", pricePerRepository: 0 },
    price: 0,
    nbRepositories: 0,
    repositories: [],
  },
  {
    conferenceID: "FSE23",
    name: "Foundations of Software Engineering 2023",
    url: "",
    startDate: ago(1200),
    endDate: ago(900),
    status: "expired",
    options: opts(),
    plan: { planID: "free_conference", name: "Free", pricePerRepository: 0 },
    price: 0,
    nbRepositories: 3,
    repositories: [],
  },
];

const plans = [
  { id: "free_conference", name: "Free", pricePerRepo: 0, storagePerRepo: -1, description: "<li><strong>Quota is deducted from user account</strong></li><li>No download</li><li>Conference dashboard</li>" },
  { id: "premium_conference", name: "Premium", pricePerRepo: 0.5, storagePerRepo: 500 * 8 * 1024, description: "<li>500 MB per repository</li><li>Repository download</li><li>Conference dashboard</li>" },
  { id: "unlimited_conference", name: "Unlimited", pricePerRepo: 3, storagePerRepo: 0, description: "<li><strong>Unlimited</strong> repository size</li><li>Repository download</li><li>Conference dashboard</li>" },
];

const stat = { nbRepositories: 41230, nbUsers: 9870, nbPageViews: 3120000, nbPullRequests: 1480 };
// Cumulative totals with uneven daily growth (weekday peaks), so the landing
// sparklines show real variation instead of identical bars.
const wave = (i, base) => Math.round(base * (1 + 0.6 * Math.sin(i / 1.3) + 0.3 * Math.cos(i / 4)));
const cumulative = (start, base) => {
  let total = start;
  return Array.from({ length: 60 }, (_, i) => (total += Math.max(0, wave(i, base))));
};
const repoSeries = cumulative(40000, 20);
const userSeries = cumulative(9500, 6);
const viewSeries = cumulative(3000000, 2000);
const prSeries = cumulative(1400, 1);
const history = Array.from({ length: 60 }, (_, i) => ({
  date: ago(59 - i),
  nbRepositories: repoSeries[i],
  nbUsers: userSeries[i],
  nbPageViews: viewSeries[i],
  nbPullRequests: prSeries[i],
}));

// ANON=1 serves the signed-out experience (landing page, FAQ) instead;
// ADMIN=1 signs in as an administrator so /admin pages render.
app.get("/api/user", (req, res) =>
  process.env.ANON
    ? res.status(401).json({ error: "not_connected" })
    : res.json({ username: "tdurieux", photo: "https://avatars.githubusercontent.com/u/5577568?v=4", isAdmin: !!process.env.ADMIN })
);
// Local connection fixtures keep the account screens usable without GitHub.
app.get("/github/connections", (req, res) => res.json({
  appEnabled: true, appConnected: true, oauthEnabled: true, oauthConnected: true,
  installations: [], gistCount: 0, resources: [], csrf: "local-preview-only",
}));
app.get("/api/options", (req, res) => res.json({ MAX_REPO_SIZE: 8 * 1024, ANONYMIZATION_MASK: "XXXX", GITHUB_APP_ENABLED: true, GITHUB_OAUTH_ENABLED: true }));
app.get("/api/message", (req, res) => res.status(404).end());
app.get("/api/user/quota", (req, res) => res.json(quota));
app.get("/api/user/anonymized_repositories", (req, res) => res.json(repositories));
app.get("/api/user/anonymized_pull_requests", (req, res) => res.json(pullRequests));
app.get("/api/user/anonymized_gists", (req, res) => res.json(gists));
app.get("/api/user/default", (req, res) =>
  res.json({ terms: ["Jane Smith", "MIT CSAIL"], options: { link: true, image: true, pdf: true, notebook: true, loc: true, page: false, update: false, mode: "GitHubStream", expirationMode: "remove" } })
);
app.post("/api/user/default", (req, res) => res.json({}));
app.get("/api/conferences/plans", (req, res) => res.json(plans));
app.get("/api/conferences/", (req, res) => res.json(conferences));
app.get("/api/conferences/:id", (req, res) => {
  const c = conferences.find((x) => x.conferenceID === req.params.id);
  return c ? res.json(c) : res.status(404).json({ error: "conf_not_found" });
});
// Explorer fixture: anonymous_github-C72C has a tiny file tree; "missing-repo"
// returns the same error the live site gives for a deleted repository.
const explorerFiles = {
  "": [
    { name: "src", path: "" },
    { name: "README.md", path: "", size: 640, sha: "a1" },
    { name: "LICENSE", path: "", size: 1070, sha: "a2" },
    { name: "requirements.txt", path: "", size: 40, sha: "a3" },
  ],
  src: [
    { name: "utils", path: "src" },
    { name: "train.py", path: "src", size: 900, sha: "b1" },
  ],
  "src/utils": [{ name: "data.py", path: "src/utils", size: 300, sha: "c1" }],
};
const explorerContent = {
  "README.md": "# DeepLearnUtils\n\nDeveloped by XXXX-1 at XXXX-2.\n\nUtilities for reproducing the paper's experiments. Every script in `src/` reads its configuration from `configs/` and writes results to `out/`, so a full run of the evaluation only needs the two commands below. The long sentence here checks the reading width of rendered Markdown.\n\n## Quick start\n\n```bash\npip install -r requirements.txt\npython src/train.py --config configs/base.yaml\n```\n\n| Model | Accuracy |\n| --- | --- |\n| Baseline | 71.2 |\n| Ours | 78.9 |\n\nContact: XXXX-3\n",
  LICENSE: "MIT License\n\nCopyright (c) 2026 XXXX-1\n",
  "requirements.txt": "torch>=2.3\nnumpy\npyyaml\n",
  "src/train.py": '# Copyright 2026 XXXX-1, XXXX-2\nimport argparse\nimport yaml\n\nfrom utils.data import load_dataset\n\n\ndef main():\n    parser = argparse.ArgumentParser(description="Train the model")\n    parser.add_argument("--config", required=True)\n    args = parser.parse_args()\n    with open(args.config) as f:\n        config = yaml.safe_load(f)\n    dataset = load_dataset(config["data"])\n    print(f"Loaded {len(dataset)} examples")\n\n\nif __name__ == "__main__":\n    main()\n',
  "src/utils/data.py": "def load_dataset(path):\n    with open(path) as f:\n        return [line.strip() for line in f]\n",
};
const EXPLORER_ID = "anonymous_github-C72C";
app.get("/api/repo/missing-repo/{*rest}", (req, res) =>
  res.status(404).json({ error: "repo_not_found" })
);
app.get(`/api/repo/${EXPLORER_ID}/options`, (req, res) =>
  res.json({
    url: null,
    download: true,
    lastUpdateDate: ago(3),
    anonymizedAt: ago(3),
    sourceCommitDate: ago(4),
    expirationDate: ahead(60),
    isAdmin: false,
    isOwner: true,
    hasWebsite: false,
    truncatedFolders: [],
    hasSubmodules: false,
  })
);
app.get(`/api/repo/${EXPLORER_ID}/files/counts`, (req, res) =>
  res.json({ "": 6, src: 2, "src/utils": 1 })
);
app.get(`/api/repo/${EXPLORER_ID}/files`, (req, res) =>
  res.json(explorerFiles[req.query.path || ""] || [])
);
app.get(`/api/repo/${EXPLORER_ID}/file/{*rest}`, (req, res) => {
  const file = req.params.rest.join("/");
  if (!(file in explorerContent)) return res.status(404).json({ error: "file_not_found" });
  res.type("text/plain").send(explorerContent[file]);
});

app.get("/api/repo/:id", (req, res) => {
  const r = repositories.find((x) => x.repoId === req.params.id) || repositories[0];
  res.json(r);
});
app.get("/api/stat", (req, res) => res.json(stat));
app.get("/api/stat/history", (req, res) => res.json(history));

// ---- Admin fixtures (ADMIN=1) ------------------------------------------------
// Shapes follow src/server/routes/admin.ts: list endpoints return raw Mongo
// documents, the user detail returns User.toJSON() with populated GitHub
// repositories, and queue jobs follow the /api/admin/queues response.

const HOUR = 60 * 60 * 1000;
const MB = 1024 * 1024;
const oid = (n) => "65f0c0de" + String(n).padStart(16, "0");

const adminUsers = [
  { n: 1, username: "tdurieux", email: "thomas@durieux.me", isAdmin: true, days: 2400, photo: "https://avatars.githubusercontent.com/u/5577568?v=4", repos: 17 },
  { n: 2, username: "alice-research", email: "alice@cs.example.edu", days: 30, repos: 3 },
  { n: 3, username: "bob-lab", email: "bob.lab@uni-example.de", days: 410, repos: 142 },
  { n: 4, username: "spammer-9000", email: "free.crypto.giveaway@mail.example", status: "banned", days: 12, repos: 0 },
  { n: 5, username: "noemail-user", email: null, days: 800, repos: 1 },
  { n: 6, username: "carol", email: "carol@example.org", status: "removed", days: 1500, repos: 0 },
  { n: 7, username: "a-very-long-github-username-for-layout-tests", email: "someone.with.a.really.long.address@department.faculty.university.example.ac.uk", days: 90, repos: 6 },
  { n: 8, username: "dmitri", email: "dmitri@example.ru", isAdmin: true, days: 5, repos: 2 },
].map((u) => ({
  _id: oid(u.n),
  username: u.username,
  emails: u.email ? [{ email: u.email, default: true, _id: oid(100 + u.n) }] : [],
  isAdmin: !!u.isAdmin,
  photo: u.photo || "https://avatars.githubusercontent.com/u/" + (1000 + u.n) + "?v=4",
  repositories: Array.from({ length: u.repos }, (_, i) => String(70000000 + u.n * 1000 + i)),
  status: u.status || "active",
  dateOfEntry: ago(u.days),
  accessTokenDates: u.status === "removed" ? {} : { github: ago(Math.min(u.days, 3)) },
  externalIDs: { github: String(1000 + u.n) },
  default: { terms: [], options: { expirationMode: "remove", update: false, image: true, pdf: true, notebook: true, link: true } },
  __v: 0,
}));

// Anonymized repositories as stored in Mongo (source.repositoryName, size.storage).
const adminRepo = (r) => ({
  _id: oid(200 + r.n),
  repoId: r.repoId,
  status: r.status,
  statusDate: r.statusDate || ago(r.days),
  statusMessage: r.statusMessage,
  anonymizeDate: ago(r.days),
  lastView: r.lastView,
  pageView: r.pageView || 0,
  owner: oid(r.owner || 1),
  coauthors: [],
  conference: r.conference,
  source: { type: "GitHubStream", branch: r.branch || "main", commit: r.commit || "c40da900ab12ef34", repositoryId: String(500000 + r.n), repositoryName: r.fullName },
  truncatedFolders: [],
  options: opts(Object.assign({ terms: r.terms || ["Jane Smith", "MIT CSAIL"] }, r.options)),
  dateOfEntry: ago(r.days),
  size: { storage: (r.storage || 0) * 8, file: r.files || 0 }, // stored in bits, like prod
  isReseted: false,
  __v: 0,
});
const adminRepos = [
  { n: 1, repoId: "anonymous_github-C72C", status: "ready", days: 3, lastView: ago(0.1), pageView: 1520, conference: "FSE25", fullName: "tdurieux/anonymous_github", storage: 48 * MB, files: 1381, options: { update: true, page: true } },
  { n: 2, repoId: "dl-benchmark-2026", status: "error", days: 0.5, owner: 2, fullName: "alice-research/dl-benchmark", statusMessage: "repository_too_big: The repository exceeds the maximum size of 8 GB (measured 11.4 GB across 214,331 files). Remove large assets (datasets, model checkpoints, LFS objects) from the branch or anonymize a smaller subfolder, then retry.", terms: ["Alice Martin"] },
  { n: 3, repoId: "JarSift", status: "expired", days: 560, lastView: ago(30), pageView: 72, conference: "FSE25", fullName: "Cornul11/JarSift", options: { expirationMode: "remove", expirationDate: ago(9) } },
  { n: 4, repoId: "fuzz-harness-7F21", status: "download", days: 0.01, owner: 3, fullName: "bob-lab/fuzz-harness", branch: "artifact-eval" },
  { n: 5, repoId: "old-paper-artifact", status: "removed", days: 1200, owner: 6, lastView: ago(900), pageView: 33, fullName: "carol/old-paper-artifact" },
  { n: 6, repoId: "runtime-repair-experiments-very-long-identifier-for-the-icse-artifact-track-2ff4", status: "ready", days: 40, owner: 7, lastView: ago(2), pageView: 5, conference: "ICSE26-AE", fullName: "a-very-long-github-username-for-layout-tests/runtime-repair-experiments", branch: "camera-ready-final-v2", storage: 3.2 * 1024 * MB, files: 48211, options: { update: true } },
  { n: 7, repoId: "crypto-airdrop", status: "removing", days: 12, owner: 4, fullName: "spammer-9000/crypto-airdrop", pageView: 4 },
  { n: 8, repoId: "graph-mining-A91B", status: "ready", days: 220, owner: 3, lastView: ago(14), pageView: 596460, fullName: "bob-lab/graph-mining", storage: 210 * MB, files: 3102, terms: [] },
  { n: 9, repoId: "b4751b8e-6139-4a94-84f8-646106435809", status: "error", days: 1990, owner: 5, fullName: "noemail-user/thesis-code", branch: "master", statusMessage: "branch_not_found" },
  { n: 10, repoId: "llm-eval-suite", status: "preparing", days: 0.002, owner: 8, fullName: "dmitri/llm-eval-suite" },
  { n: 11, repoId: "smart-contract-audit", status: "expiring", days: 365, owner: 2, lastView: ago(1), pageView: 210, conference: "FSE25", fullName: "alice-research/smart-contract-audit", storage: 12 * MB, files: 240, options: { expirationMode: "redirect", expirationDate: ago(0.1) } },
].map(adminRepo);

// Repository.toJSON() as returned by /api/admin/users/:username/repos.
const repoView = (r) => ({
  repoId: r.repoId,
  options: r.options,
  coauthors: r.coauthors,
  conference: r.conference,
  anonymizeDate: r.anonymizeDate,
  status: r.status,
  statusMessage: r.statusMessage,
  lastView: r.lastView,
  pageView: r.pageView,
  size: r.status === "ready" ? r.size : { storage: 0, file: 0 },
  source: { repositoryID: r.source.repositoryId, fullName: r.source.repositoryName, commit: r.source.commit, branch: r.source.branch, type: r.source.type },
});

// Populated GitHub repositories on the user detail (Repository model).
const githubRepos = (u) =>
  u.repositories.slice(0, 40).map((id, i) => ({
    _id: oid(9000 + i),
    externalId: "gh_" + id,
    name: u.username + "/" + ["paper-artifact", "dataset-tools", "experiments", "website", "dotfiles", "replication-package-with-a-long-name"][i % 6] + (i >= 6 ? "-" + i : ""),
    url: "https://github.com/" + u.username,
    source: "github",
    hasPage: i % 4 === 0,
    branches: [],
    defaultBranch: "main",
    size: [120, 48213, 3, 980000, 0, 15400][i % 6],
    status: "ready",
    dateOfEntry: ago(30 + i),
    __v: 0,
  }));

const statusCounts = (rows, withStorage) => {
  const map = {};
  rows.forEach((r) => {
    const row = (map[r.status] = map[r.status] || { _id: r.status, count: 0 });
    row.count++;
    if (withStorage) row.storage = (row.storage || 0) + (r.size ? r.size.storage : 0);
  });
  return Object.values(map);
};
const page = (req, rows, withStorage) => {
  const counts = statusCounts(rows, withStorage);
  const sort = { [req.query.sort || "_id"]: req.query.direction === "asc" ? 1 : -1 };
  const out = { query: {}, page: parseInt(req.query.page, 10) || 1, total: rows.length, sort, results: rows, statusCounts: counts };
  if (withStorage) out.totalSize = counts.reduce((t, c) => t + (c.storage || 0), 0);
  return out;
};

// Conferences as stored in Mongo (repositories are {id, addDate} refs).
const adminConferences = [
  { conferenceID: "FSE25", name: "Foundations of Software Engineering 2025", url: "https://conf.researchr.org/home/fse-2025", startDate: ago(400), endDate: ahead(30), status: "ready", plan: { planID: "premium_conference", pricePerRepository: 0.5, quota: { repository: 0, size: 500 * 8 * 1024, file: 0 } }, price: 12.5, repos: 25 },
  { conferenceID: "ICSE26-AE", name: "ICSE 2026 Artifact Evaluation", url: "https://conf.researchr.org/home/icse-2026", startDate: ahead(10), endDate: ahead(120), status: "preparing", plan: { planID: "unlimited_conference", pricePerRepository: 3, quota: { repository: 0, size: 0, file: 0 } }, price: 1260, repos: 420 },
  { conferenceID: "FSE23", name: "Foundations of Software Engineering 2023", url: "", startDate: ago(1200), endDate: ago(900), status: "expired", plan: { planID: "free_conference", pricePerRepository: 0 }, repos: 3 },
  { conferenceID: "MSR-WORKSHOP-ON-REPRODUCIBILITY-AND-OPEN-SCIENCE-2026", name: "International Workshop on Reproducibility, Replicability and Open Science in Mining Software Repositories", url: "https://example.org/msr-ros", startDate: ago(20), endDate: ahead(5), status: "error", plan: { planID: "free_conference", pricePerRepository: 0 }, repos: 0 },
].map((c, i) => ({
  _id: oid(300 + i),
  name: c.name,
  conferenceID: c.conferenceID,
  url: c.url,
  startDate: c.startDate,
  endDate: c.endDate,
  status: c.status,
  owners: [oid(1)],
  repositories: Array.from({ length: c.repos }, (_, j) => ({ id: oid(5000 + j), addDate: ago(j % 60), _id: oid(6000 + j) })),
  options: { expirationMode: "remove", expirationDate: c.endDate, update: false, image: true, pdf: true, notebook: true, link: true, page: false },
  dateOfEntry: c.startDate,
  plan: c.plan,
  price: c.price,
  billing: c.price ? { name: "Program Chairs", email: "chairs@example.org", country: "DE" } : undefined,
  __v: 0,
}));

// ---- Overview & performance

const overview = {
  system: {
    platform: "linux", arch: "x64", nodeVersion: "v22.11.0", uptime: 3 * 86400 + 7 * 3600 + 120,
    cpuCount: 8, cpuPercent: 37, loadAvg: [2.96, 2.41, 2.2],
    memTotal: 32 * 1024 * MB, memFree: 9.5 * 1024 * MB, memUsed: 22.5 * 1024 * MB, memPercent: 70,
    processRss: 612 * MB, processHeapUsed: 280 * MB, processHeapTotal: 350 * MB,
    diskTotal: 1000 * 1024 * MB, diskUsed: 912 * 1024 * MB, diskFree: 88 * 1024 * MB, diskPercent: 91, diskMount: "/",
  },
  repos: {
    total: 41230,
    statusBreakdown: [
      { _id: "ready", count: 30112, storage: 1.9e12 },
      { _id: "expired", count: 6200, storage: 0 },
      { _id: "removed", count: 3810, storage: 0 },
      { _id: "error", count: 920, storage: 0 },
      { _id: "download", count: 14, storage: 0 },
      { _id: "preparing", count: 6, storage: 0 },
      { _id: "expiring", count: 120, storage: 2e9 },
      { _id: "removing", count: 48, storage: 0 },
    ],
    totalStorage: 1.902e12,
    recentErrors24h: 17,
    activeRepos24h: 2310,
    newRepos24h: 64,
  },
  users: { total: 9870, newUsers24h: 23 },
  conferences: { total: adminConferences.length },
  queues: {
    download: { waiting: 12, active: 4, completed: 1840, failed: 7, delayed: 2 },
    remove: { waiting: 0, active: 1, completed: 310, failed: 0, delayed: 0 },
    cache: { waiting: 230, active: 2, completed: 9120, failed: 41, delayed: 0 },
  },
  errors: { last24h: 312, severity: { error: 41, warn: 118, info: 153 } },
  // Same daily rows as the landing stats, last 30 days only.
  history: history.slice(-30),
};

const LATENCY_BUCKETS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];
const metricRow = (service, metric, route, method, count, avgMs, p95, p99, extra) =>
  Object.assign({
    metric, route, method, count, sumMs: count * avgMs, bytes: 0, aborted: 0, errors: 0, slow: 0,
    buckets: LATENCY_BUCKETS.map((b, i) => (b >= avgMs && i < 6 ? Math.round(count / 6) : 0)).concat([0]),
    service, avgMs, p95UpperMs: p95, p99UpperMs: p99,
  }, extra || {});
const instance = (name, service, extra) => Object.assign({
  instance: name, service, sampledAt: Date.now() - 8000, uptime: 86400, cpuPercent: 12.4,
  memoryLimitBytes: 2048 * MB, memory: { rss: 410 * MB, heapTotal: 300 * MB, heapUsed: 220 * MB, external: 30 * MB, arrayBuffers: 4 * MB },
  activeRequests: 3, sockets: { descriptors: 42, established: 38, closeWait: 0, listening: 1, truncated: false },
  workers: null, eventLoop: { utilization: 0.21, p95Ms: 18.2, maxMs: 64 }, droppedMetrics: 0, droppedBatches: 0, lastFlushAt: Date.now() - 8000,
}, extra || {});
const performanceFor = (minutes) => {
  const windowMinutes = minutes === 60 ? 60 : 15;
  const scale = windowMinutes / 15;
  const n = (v) => Math.round(v * scale);
  const now = Math.floor(Date.now() / 60000) * 60000;
  const instances = [
    instance("api:anon-api-7c9d4", "api"),
    instance("api:anon-api-b21fe", "api", { cpuPercent: 88.6, eventLoop: { utilization: 0.83, p95Ms: 142.7, maxMs: 910 }, activeRequests: 57 }),
    instance("streamer:anon-streamer-0", "streamer", { memory: { rss: 1780 * MB, heapTotal: 900 * MB, heapUsed: 700 * MB, external: 600 * MB, arrayBuffers: 500 * MB },
      sockets: { descriptors: 210, established: 180, closeWait: 6, listening: 1, truncated: false }, workers: { running: 4, waiting: 11, reservedBytes: 640 * MB } }),
    instance("streamer:anon-streamer-1", "streamer", { sampledAt: Date.now() - 70000, sockets: null, workers: { running: 0, waiting: 0, reservedBytes: 0 }, droppedBatches: 2, droppedMetrics: 130 }),
  ];
  return {
    available: true,
    generatedAt: Date.now(),
    windowMinutes,
    instances,
    routes: [
      metricRow("streamer", "request", "/api/repo/:repoId/file/:path", "GET", n(18230), 240, 1000, 5000, { bytes: n(9.1e9), aborted: n(41), errors: n(3), slow: n(88), firstByteCount: n(18100), firstByteP95UpperMs: 500 }),
      metricRow("api", "request", "/api/repo/:repoId/files", "GET", n(9120), 85, 250, 1000, { firstByteCount: n(9120), firstByteP95UpperMs: 250 }),
      metricRow("api", "request", "/api/repo/:repoId/zip", "GET", n(37), 18400, 30000, null, { bytes: n(4.2e9), aborted: n(9), slow: n(31), firstByteCount: n(37), firstByteP95UpperMs: 2500 }),
      metricRow("api", "request", "/api/admin/overview", "GET", n(30), 410, 1000, 1000, { firstByteCount: n(30), firstByteP95UpperMs: 1000 }),
      metricRow("api", "request", "/api/repo/:repoId/refresh", "POST", n(12), 3100, 10000, 10000, { errors: n(4), firstByteCount: 0, firstByteP95UpperMs: null }),
      metricRow("api", "request", "/api/user", "GET", n(5400), 6, 10, 50, { firstByteCount: n(5400), firstByteP95UpperMs: 10 }),
    ].sort((a, b) => b.sumMs - a.sumMs),
    stages: [
      metricRow("streamer", "repository", "all", "all", n(18230), 4, 10, 50),
      metricRow("streamer", "authorization", "all", "all", n(18230), 2, 10, 10),
      metricRow("streamer", "upstream", "all", "all", n(2100), 620, 2500, 10000, { errors: n(12) }),
      metricRow("streamer", "cache_lookup", "all", "all", n(18230), 3, 10, 50),
      metricRow("streamer", "cache_fill", "all", "all", n(2100), 140, 500, 1000),
      metricRow("streamer", "worker_wait", "all", "all", n(1600), 380, 2500, 5000),
      metricRow("streamer", "anonymize", "all", "all", n(2100), 55, 250, 500),
      metricRow("streamer", "source_hit", "all", "all", n(16130), 0, 10, 10),
      metricRow("streamer", "source_miss", "all", "all", n(2100), 0, 10, 10),
      metricRow("streamer", "first_byte", "/api/repo/:repoId/file/:path", "GET", n(18100), 90, 500, 1000),
    ],
    series: Array.from({ length: windowMinutes }, (_, i) => ({
      minute: now - (windowMinutes - 1 - i) * 60000,
      requests: 900 + Math.round(400 * Math.sin(i / 2)), aborted: i % 5 === 0 ? 3 : 0, errors: i === 7 ? 4 : 0, sumMs: 90000 + i * 1200,
    })),
    runtimeSeries: instances.flatMap((s) => Array.from({ length: windowMinutes * 4 }, (_, i) => ({
      instance: s.instance, service: s.service, sampledAt: Date.now() - i * 15000,
      rss: s.memory.rss * (1 + 0.2 * Math.sin(i / 5)), heapUsed: s.memory.heapUsed, external: s.memory.external,
      cpuPercent: s.cpuPercent, loopP95Ms: s.eventLoop.p95Ms, sockets: s.sockets ? s.sockets.descriptors : null,
      closeWait: s.sockets ? s.sockets.closeWait : null, waiting: s.workers ? s.workers.waiting : 0, reservedBytes: s.workers ? s.workers.reservedBytes : 0,
    }))),
    latencyBucketsMs: LATENCY_BUCKETS,
    percentileNote: "Percentiles are histogram bucket upper bounds; null means no samples or above 60s.",
  };
};

// ---- Queues
// Jobs mirror /api/admin/queues: BullMQ job.asJSON() with data, failedReason,
// stacktrace and returnvalue restored to their parsed values.

const QUEUES = [
  { key: "download", label: "Download", counts: { waiting: 12, active: 4, completed: 1840, failed: 7, delayed: 2 }, paused: false, workers: 2, concurrency: 4, completed24h: 1712, failed24h: 9 },
  { key: "remove", label: "Remove", counts: { waiting: 0, active: 1, completed: 310, failed: 0, delayed: 0 }, paused: false, workers: 1, concurrency: 1, completed24h: 44, failed24h: 0 },
  { key: "cache", label: "Cache cleanup", counts: { waiting: 230, active: 2, completed: 9120, failed: 41, delayed: 0 }, paused: true, workers: 0, concurrency: null, completed24h: 0, failed24h: 0 },
];
const job = (state, repoId, j) => {
  const ts = Date.now() - (j.ageMin || 1) * 60000;
  const out = {
    id: j.id || repoId,
    name: repoId,
    data: { repoId },
    opts: { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 1000, removeOnFail: 1000 },
    progress: j.progress === undefined ? 0 : j.progress,
    attemptsMade: j.attemptsMade || 0,
    attemptsStarted: j.attemptsMade || 0,
    stalledCounter: 0,
    timestamp: ts,
    processedOn: state === "waiting" || state === "delayed" ? undefined : ts + 2000,
    finishedOn: state === "completed" || state === "failed" ? ts + 2000 + (j.durationMs || 4200) : undefined,
    failedReason: j.failedReason,
    stacktrace: j.stacktrace || [],
    returnvalue: state === "completed" ? null : undefined,
    _state: state,
  };
  if (state === "delayed") out.delayUntil = ts + 5 * 60000;
  return out;
};
const queueJobs = {
  download: [
    job("active", "fuzz-harness-7F21", { ageMin: 2, progress: { status: "get_files", percent: 42 } }),
    job("active", "llm-eval-suite", { ageMin: 0.5, progress: { status: "anonymize" } }),
    job("active", "runtime-repair-experiments-very-long-identifier-for-the-icse-artifact-track-2ff4", { ageMin: 9, progress: 87 }),
    job("waiting", "graph-mining-A91B", { ageMin: 1 }),
    job("waiting", "smart-contract-audit", { ageMin: 3 }),
    job("delayed", "dl-benchmark-2026", { ageMin: 4, attemptsMade: 1 }),
    job("failed", "b4751b8e-6139-4a94-84f8-646106435809", { ageMin: 50, attemptsMade: 3, durationMs: 31000,
      failedReason: "branch_not_found: the branch 'master' does not exist in noemail-user/thesis-code (GitHub returned 404 Not Found for GET /repos/noemail-user/thesis-code/branches/master)",
      stacktrace: [
        "AnonymousError: branch_not_found\n    at GitHubStream.getBranchCommit (/app/build/core/source/GitHubStream.js:212:19)\n    at async Repository.updateIfNeeded (/app/build/core/Repository.js:488:27)\n    at async Repository.anonymize (/app/build/core/Repository.js:531:9)\n    at async default (/app/build/queue/processes/downloadRepository.js:41:9)\n    at async Worker.processJob (/app/node_modules/bullmq/dist/cjs/classes/worker.js:463:28)",
        "AnonymousError: branch_not_found\n    at GitHubStream.getBranchCommit (/app/build/core/source/GitHubStream.js:212:19)",
      ] }),
    job("failed", "dl-benchmark-2026-retry", { ageMin: 300, attemptsMade: 1, failedReason: "repository_too_big" }),
    job("completed", "anonymous_github-C72C", { ageMin: 15, progress: { status: "ready", percent: 100 }, durationMs: 12800 }),
    job("completed", "JarSift", { ageMin: 120, durationMs: 640 }),
  ],
  remove: [
    job("active", "crypto-airdrop", { ageMin: 1 }),
    job("completed", "old-paper-artifact", { ageMin: 2000, durationMs: 230 }),
  ],
  cache: [],
};
const metricsPoints = (queue, range) => {
  const minutes = { "1h": 60, "6h": 360, "24h": 1440, "7d": 10080 }[range] || 60;
  const now = Math.floor(Date.now() / 60000) * 60000;
  const quiet = queue === "cache"; // paused queue: flat zero line
  return Array.from({ length: minutes }, (_, i) => {
    const t = now - (minutes - 1 - i) * 60000;
    const completed = quiet ? 0 : Math.max(0, Math.round(2 + 2 * Math.sin(i / 17) + (i % 37 === 0 ? 9 : 0)));
    const failed = quiet ? 0 : i % 53 === 0 ? 2 : 0;
    return { ts: t, completed, failed, avgMs: completed + failed ? 1800 + (i % 13) * 250 : 0 };
  });
};

// ---- Errors (logger ring entries: { ts, level, module, message, raw })

const errorEntries = [
  [0.02, "error", "streamer", "anonymous error", { name: "AnonymousError", message: "file_not_found", httpStatus: 500, detail: "dl-benchmark-2026", url: "/api/repo/dl-benchmark-2026/file/data/train/part-00031.parquet", cause: { name: "Error", message: "ENOENT: no such file or directory, open '/data/repos/dl-benchmark-2026/data/train/part-00031.parquet'", stack: "Error: ENOENT: no such file or directory, open '/data/repos/dl-benchmark-2026/data/train/part-00031.parquet'\n    at async open (node:internal/fs/promises:639:25)\n    at async FileSystem.read (/app/build/core/storage/FileSystem.js:58:22)\n    at async AnonymizedFile.content (/app/build/core/AnonymizedFile.js:301:24)" } }],
  [0.05, "warn", "github", "GitHub API rate limit low", { name: "HttpError", message: "API rate limit exceeded for installation ID 41234567.", status: 403, url: "https://api.github.com/repos/bob-lab/graph-mining/git/trees/c40da900ab12?recursive=1", method: "GET" }],
  [0.1, "error", "download", "anonymous error", { name: "AnonymousError", message: "repository_too_big", httpStatus: 500, detail: JSON.stringify({ repoId: "dl-benchmark-2026", size: 12241827840, limit: 8589934592, fullName: "alice-research/dl-benchmark" }) }],
  [0.3, "error", "streamer", "anonymous error", { name: "AnonymousError", message: "file_not_found", httpStatus: 500, detail: "dl-benchmark-2026", url: "/api/repo/dl-benchmark-2026/file/data/train/part-00032.parquet" }],
  [0.4, "error", "api", "unhandled error", { name: "TypeError", message: "Cannot read properties of undefined (reading 'repositoryName')", stack: "TypeError: Cannot read properties of undefined (reading 'repositoryName')\n    at Repository.toJSON (/app/build/core/Repository.js:1127:38)\n    at JSON.stringify (<anonymous>)\n    at ServerResponse.json (/app/node_modules/express/lib/response.js:263:14)\n    at /app/build/server/routes/admin.js:912:17\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)" }],
  [0.8, "warn", "api", "anonymous error", { name: "AnonymousError", message: "invalid_terms_format", httpStatus: 400, url: "/api/repo/new-paper/", method: "POST", detail: "Terms must be an array of non-empty strings; received a single string of 2,048 characters containing newlines, which usually means the terms were pasted into the wrong field." }],
  [1.5, "error", "streamer", "anonymous error", { name: "AnonymousError", message: "file_not_found", httpStatus: 500, detail: "dl-benchmark-2026", url: "/api/repo/dl-benchmark-2026/file/README.md" }],
  [2, "error", "queue", "job failed", { name: "AnonymousError", message: "branch_not_found", httpStatus: 404, detail: "b4751b8e-6139-4a94-84f8-646106435809" }],
  [3.4, "warn", "mongo", "slow query", { name: "MongoServerSelectionError", message: "Server selection timed out after 30000 ms", code: "ETIMEDOUT" }],
  [5, "error", "storage", "s3 put failed", { name: "S3ServiceException", message: "SlowDown: Please reduce your request rate.", status: 503, url: "https://s3.eu-west-1.amazonaws.com/anon-cache/repos/graph-mining-A91B/src/main.py" }],
  [6, "warn", "github", "GitHub API rate limit low", { name: "HttpError", message: "API rate limit exceeded for installation ID 41234567.", status: 403, url: "https://api.github.com/repos/bob-lab/fuzz-harness", method: "GET" }],
  [9, "error", "api", "anonymous error", { name: "AnonymousError", message: "repository_expired", httpStatus: 410, detail: "JarSift", url: "/api/repo/JarSift/files" }],
  [14, "warn", "streamer", "client aborted", { name: "Error", message: "aborted", code: "ECONNRESET", url: "/api/repo/runtime-repair-experiments-very-long-identifier-for-the-icse-artifact-track-2ff4/zip" }],
  [20, "error", "api", "unhandled error", { name: "RangeError", message: "Maximum call stack size exceeded", stack: "RangeError: Maximum call stack size exceeded\n    at anonymizeContent (/app/build/core/anonymize-utils.js:88:18)\n    at anonymizeContent (/app/build/core/anonymize-utils.js:102:16)\n    at anonymizeContent (/app/build/core/anonymize-utils.js:102:16)\n    at anonymizeContent (/app/build/core/anonymize-utils.js:102:16)" }],
  [23, "warn", "conference", "billing webhook", { message: "Stripe webhook signature mismatch for event evt_1Q2w3E4r5T6y7U8i (conference ICSE26-AE)" }],
  [23.5, "error", "streamer", "anonymous error", { name: "AnonymousError", message: "file_not_found", httpStatus: 500, detail: "graph-mining-A91B", url: "/api/repo/graph-mining-A91B/file/docs/very/deeply/nested/folder/structure/that/keeps/going/and/going/index.html" }],
].map(([hoursAgo, level, module, message, detail]) => ({
  ts: new Date(Date.now() - hoursAgo * HOUR).toISOString(),
  level,
  module,
  message,
  raw: [message, detail],
}));
const errorStats = (() => {
  const hourNow = Math.floor(Date.now() / HOUR) * HOUR;
  const buckets = Array.from({ length: 24 }, (_, i) => {
    const spike = i === 20 ? 6 : 1; // an incident a few hours ago
    return { hour: hourNow - (23 - i) * HOUR + HOUR, error: Math.round((1 + (i % 4)) * spike), warn: 3 + (i % 6), info: i % 3 === 0 ? 0 : 8 + (i % 5) };
  });
  const severity = { error: 0, warn: 0, info: 0 };
  buckets.forEach((b) => { severity.error += b.error; severity.warn += b.warn; severity.info += b.info; });
  const last24h = severity.error + severity.warn + severity.info;
  return { available: true, last24h, prev24h: Math.round(last24h * 0.74), severity, unique: { error: 7, warn: 4, info: 3 }, buckets, dropped: 12 };
})();

const adminTokens = [
  { id: oid(700), name: "ci-deploy", createdAt: ago(200), lastUsedAt: ago(0.01) },
  { id: oid(701), name: "local laptop (never used)", createdAt: ago(3) },
];

const ok = (req, res) => res.json({ ok: true });
app.get("/api/admin/overview", (req, res) => res.json(overview));
app.get("/api/admin/performance", (req, res) => res.json(performanceFor(Number(req.query.minutes))));
app.get("/api/admin/stats", (req, res) => res.json({
  statusBreakdown: overview.repos.statusBreakdown, totalStorage: overview.repos.totalStorage,
  recentErrors24h: overview.repos.recentErrors24h, totalUsers: overview.users.total, totalConferences: adminConferences.length,
}));
app.get("/api/admin/repos", (req, res) => {
  let rows = adminRepos;
  if (req.query.owner) {
    const u = adminUsers.find((x) => x.username === req.query.owner);
    rows = u ? rows.filter((r) => r.owner === u._id) : [];
  }
  if (req.query.conference) rows = rows.filter((r) => r.conference === req.query.conference);
  res.json(page(req, rows, true));
});
app.get("/api/admin/repos/:repoId/github", (req, res) => {
  const r = adminRepos.find((x) => x.repoId === req.params.repoId) || adminRepos[0];
  const [owner, repo] = r.source.repositoryName.split("/");
  res.json({
    source: { owner, repo, branch: r.source.branch, commit: r.source.commit },
    repository: { fullName: r.source.repositoryName, private: true, archived: false, disabled: false, defaultBranch: "main", description: "Replication package", stargazers: 3, watchers: 3, forks: 0, openIssues: 1, size: 48213, language: "Python", license: "MIT", createdAt: ago(400), updatedAt: ago(2), pushedAt: ago(2), htmlUrl: "https://github.com/" + r.source.repositoryName, topics: [] },
    branchError: r.status === "error" ? "Branch not found" : undefined,
    rateLimit: { remaining: 4123, limit: 5000, reset: ahead(0.03) },
  });
});
app.delete("/api/admin/repos/:repoId", (req, res) => res.json({ status: "ready" }));
app.get("/api/admin/users", (req, res) => {
  const rows = adminUsers.map((u) => {
    const { repositories, ...rest } = u;
    return Object.assign(rest, { repositories, repoCount: repositories.length });
  });
  res.json(page(req, rows, false));
});
app.get("/api/admin/users/:username/repos", (req, res) => {
  const u = adminUsers.find((x) => x.username === req.params.username);
  if (!u) return res.status(404).json({ error: "user_not_found" });
  res.json(adminRepos.filter((r) => r.owner === u._id).map(repoView));
});
app.get("/api/admin/users/:username", (req, res) => {
  const u = adminUsers.find((x) => x.username === req.params.username);
  if (!u) return res.status(404).json({ error: "user_not_found" });
  res.json(Object.assign({}, u, { repositories: githubRepos(u) }));
});
app.post("/api/admin/users/:username/ban", (req, res) => res.json({ ok: true, reposQueued: 2 }));
app.post("/api/admin/users/:username/:action", ok);
app.get("/api/user/:username/all_repositories", (req, res) => {
  const u = adminUsers.find((x) => x.username === req.params.username) || adminUsers[0];
  res.json(githubRepos(u));
});
app.get("/api/admin/tokens", (req, res) => res.json(adminTokens));
app.post("/api/admin/tokens", (req, res) => res.json({ id: oid(799), name: "new token", createdAt: new Date().toISOString(), token: "agh_mock_0123456789abcdef0123456789abcdef" }));
app.delete("/api/admin/tokens/:id", (req, res) => res.json({ removed: 1 }));
app.get("/api/admin/conferences", (req, res) => res.json(page(req, adminConferences, false)));
app.delete("/api/admin/conferences/:id", ok);
app.get("/api/admin/queues/metrics", (req, res) => {
  const queue = String(req.query.queue || "download");
  const range = String(req.query.range || "1h");
  res.json({ queue, range, points: metricsPoints(queue, range) });
});
app.get("/api/admin/queues", (req, res) => {
  const selected = QUEUES.some((q) => q.key === req.query.queue) ? req.query.queue : "download";
  const search = String(req.query.search || "").toLowerCase();
  const jobs = queueJobs[selected].filter((j) => !search || j.id.toLowerCase().includes(search) || j.name.toLowerCase().includes(search));
  res.json({ queues: QUEUES, selectedQueue: selected, jobs });
});
app.post("/api/admin/queues/pause-all", ok);
app.post("/api/admin/queue/:name/retry-failed", (req, res) => res.json({ retried: 2, total: 2 }));
app.post("/api/admin/queue/:name/:action", ok);
app.delete("/api/admin/queue/:name/:id", ok);
app.get("/api/admin/errors", (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 250));
  res.json({ entries: errorEntries.slice(offset, offset + limit), offset, limit, total: errorEntries.length, max: 5000, available: true });
});
app.get("/api/admin/errors/stats", (req, res) => res.json(errorStats));
app.delete("/api/admin/errors", (req, res) => res.json({ ok: true, cleared: errorEntries.length, hourlyCleared: 48 }));

app.all("/api/{*rest}", (req, res) => res.status(404).json({ error: "not mocked: " + req.path }));

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  next();
});
// index: false so "/" falls through to the placeholder-filled index.html below.
app.use(express.static(PUBLIC_DIR, { etag: false, cacheControl: false, index: false }));
app.get("/{*rest}", (req, res) => res.type("html").send(indexHtml()));

app.listen(PORT, () => {
  console.log(`mock ui  http://localhost:${PORT}/dashboard`);
});
