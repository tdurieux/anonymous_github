/**
 * Dev proxy for local UI iteration.
 *
 * Serves the local `public/` folder for HTML/CSS/JS/partials/images so you
 * see your design changes instantly, and proxies everything else (API,
 * auth, repo content, …) to the live https://anonymous.4open.science site.
 *
 *   npm run dev:ui         # default port 4001
 *   PORT=5000 npm run dev:ui
 *
 * Notes
 * - Cookies from upstream are rewritten so they stick on localhost:
 *     • `Secure` flag stripped
 *     • `Domain=anonymous.4open.science` stripped
 * - GitHub OAuth callback points at the production host, so live sign-in
 *   won't complete against localhost. You can still browse as an anonymous
 *   visitor (landing page, FAQ, anonymous repo mirrors) with full data.
 */

const path = require("path");
const express = require("express");
const {
  createProxyMiddleware,
  responseInterceptor,
} = require("http-proxy-middleware");

const fs = require("fs");

const UPSTREAM = process.env.UPSTREAM || "https://anonymous.4open.science";
const PORT = parseInt(process.env.PORT || "4001", 10);
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

// Re-read manifest on each request so gulp rebuilds are picked up instantly.
const manifestPath = path.join(PUBLIC_DIR, "asset-manifest.json");
function asset(name) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    return manifest[name] || name;
  } catch {
    return name;
  }
}

// Paths that should always be served from the local `public/` folder.
// Anything else falls through to the proxy.
const LOCAL_PREFIXES = [
  "/css/",
  "/script/",
  "/partials/",
  "/fonts/",
  "/imgs/",
  "/i18n/",
  "/favicon/",
  "/favicon.ico",
  "/robots.txt",
];

function isLocalPath(urlPath) {
  if (urlPath === "/" || urlPath === "/index.html") return true;
  return LOCAL_PREFIXES.some((p) => urlPath === p || urlPath.startsWith(p));
}

const app = express();

// 0) Serve hashed asset filenames by stripping the hash.
app.get(/^\/(script|css)\/(.+)\.([a-f0-9]{10})\.(min\.\w+|\w+)$/, (req, res, next) => {
  const dir = req.params[0];
  const base = req.params[1];
  const ext = req.params[3];
  const filePath = path.join(PUBLIC_DIR, dir, `${base}.${ext}`);
  if (!fs.existsSync(filePath)) return next();
  res.sendFile(filePath);
});

// 1) Local static for the UI shell.
app.use((req, res, next) => {
  if (req.method === "GET" && isLocalPath(req.path)) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    // The SPA entry: serve index.html with asset-hash placeholders filled in.
    if (req.path === "/" || req.path === "/index.html") {
      let html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf-8");
      html = html
        .replace("__CORE_JS__", asset("core.min.js"))
        .replace("__VENDOR_JS__", asset("vendor.min.js"))
        .replace("__MERMAID_JS__", asset("mermaid.min.js"))
        .replace("__ALL_CSS__", asset("all.min.css"));
      res.type("html").send(html);
      return;
    }
    return express.static(PUBLIC_DIR, {
      fallthrough: true,
      etag: false,
      cacheControl: false,
    })(req, res, next);
  }
  next();
});

// 2) SPA catch-all: serve local index.html for HTML page navigations
//    so all routes use the local shell (with split bundles).
app.use((req, res, next) => {
  const accept = req.headers.accept || "";
  if (
    req.method === "GET" &&
    accept.includes("text/html") &&
    !req.path.startsWith("/api/") &&
    !req.path.startsWith("/github/") &&
    !req.path.startsWith("/w/")
  ) {
    let html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf-8");
    html = html
      .replace("__CORE_JS__", asset("core.min.js"))
      .replace("__VENDOR_JS__", asset("vendor.min.js"))
      .replace("__MERMAID_JS__", asset("mermaid.min.js"))
      .replace("__ALL_CSS__", asset("all.min.css"));
    res.type("html").send(html);
    return;
  }
  next();
});

// 3) Proxy everything else to the live site.
app.use(
  createProxyMiddleware({
    target: UPSTREAM,
    changeOrigin: true,
    secure: true,
    ws: true,
    xfwd: false,
    followRedirects: false,
    selfHandleResponse: true, // so we can rewrite Set-Cookie + HTML
    cookieDomainRewrite: "",
    cookiePathRewrite: "/",
    onProxyReq(proxyReq, req) {
      // Make upstream think the request came in over HTTPS at its domain.
      proxyReq.setHeader("origin", UPSTREAM);
      proxyReq.setHeader("referer", UPSTREAM + req.originalUrl);
    },
    onProxyRes: responseInterceptor(async (buffer, proxyRes, req, res) => {
      // Rewrite Set-Cookie so cookies stick on localhost.
      const setCookie = proxyRes.headers["set-cookie"];
      if (setCookie) {
        const rewritten = setCookie.map((c) =>
          c
            .replace(/;\s*Secure/gi, "")
            .replace(/;\s*Domain=[^;]+/gi, "")
            .replace(/;\s*SameSite=None/gi, "; SameSite=Lax"),
        );
        res.setHeader("set-cookie", rewritten);
      }

      // Rewrite Location headers on 3xx redirects.
      const location = proxyRes.headers["location"];
      if (location && typeof location === "string") {
        try {
          const u = new URL(location, UPSTREAM);
          if (u.origin === UPSTREAM) {
            res.setHeader("location", u.pathname + u.search + u.hash);
          }
        } catch {
          /* leave as-is */
        }
      }

      const ct = String(proxyRes.headers["content-type"] || "");
      if (ct.includes("text/html")) {
        // Swap upstream domain references in HTML so relative navigation
        // stays on localhost.
        const body = buffer
          .toString("utf8")
          .replace(new RegExp(UPSTREAM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "");
        return body;
      }
      return buffer;
    }),
    logLevel: "warn",
  }),
);

app.listen(PORT, () => {
  console.log(
    `\n  dev-proxy  http://localhost:${PORT}` +
      `\n  → local:   ${PUBLIC_DIR}` +
      `\n  → upstream ${UPSTREAM}\n`,
  );
});
