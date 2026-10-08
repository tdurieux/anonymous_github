// Local fixture server for resource checks in the collaborative browser.
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const app = express();
const root = path.resolve("public");
const files = Array.from({ length: 20 }, (_, i) => ({ name: `file${i}.js`, path: "", sha: "1", size: 30 }));
files.push({ name: "long.pdf", path: "", sha: "1", size: 10000 });
function pdf(count) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids = [];
  for (let i = 0; i < count; i++) {
    const page = objects.length + 1, content = page + 1;
    kids.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`);
    const text = `BT /F1 24 Tf 72 720 Td (Performance fixture page ${i + 1}) Tj ET`;
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${count} >>`;
  let output = "%PDF-1.4\n", offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
const document = pdf(100);
app.use(express.json());
app.get("/api/user", (_req, res) => res.json({ username: "perf-user" }));
app.get("/api/user/quota", (_req, res) => res.json({ storage: { used: 0, total: 1000000 }, file: { used: 0, total: 0 }, repository: { used: 150, total: 200 } }));
app.get("/api/user/dashboard", (req, res) => {
  let rows = Array.from({ length: 150 }, (_, i) => ({ repoId: `project-${String(i).padStart(3, "0")}`, _type: "repo", status: i % 10 ? "ready" : "error", source: { fullName: `owner/project-${i}` }, pageView: i, options: { terms: [], expirationMode: "never" } }));
  const total = rows.length;
  if (req.query.q) rows = rows.filter(row => row.repoId.includes(req.query.q));
  if (req.query.type && !["all", "repo"].includes(req.query.type)) rows = [];
  if (req.query.statuses) rows = rows.filter(row => req.query.statuses.split(",").includes(row.status));
  if (req.query.attention === "true") rows = rows.filter(row => row.status === "error");
  const offset = Number(req.query.cursor) || 0;
  res.json({ items: rows.slice(offset, offset + 50), cursor: offset + 50 < rows.length ? String(offset + 50) : null, total, filtered: rows.length, attention: 15 });
});
app.get("/api/repo/perf/options", (_req, res) => res.json({ status: "ready", terms: [], image: true, pdf: true, notebook: true, lastUpdateDate: 0 }));
app.get("/api/repo/perf/files/", (_req, res) => res.json(files));
app.get("/api/repo/perf/files/counts", (_req, res) => res.json({ "": files.length }));
app.get("/api/repo/perf/file/long.pdf", (_req, res) => res.type("pdf").send(document));
app.get("/api/repo/perf/file/:filename", (req, res) => res.type("text/plain").send(`// ${req.params.filename}\nconst value = 1;`));
app.use("/api", (_req, res) => res.json({}));
app.use((req, _res, next) => { req.url = req.url.replace(/\.[a-f0-9]{10}\.min\./, ".min."); next(); });
app.use(express.static(root, { index: false }));
const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
  .replace("__CORE_JS__", "core.min.js").replace("__VENDOR_JS__", "vendor.min.js")
  .replace("__MERMAID_JS__", "mermaid.min.js").replace("__ALL_CSS__", "all.min.css")
  .replace('<script src="/script/core.min.js">', `<script>
    window.__hashListeners = new Set();
    const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
    window.addEventListener = (type, callback, options) => { if (type === "hashchange") window.__hashListeners.add(callback); return add(type, callback, options); };
    window.removeEventListener = (type, callback, options) => { if (type === "hashchange") window.__hashListeners.delete(callback); return remove(type, callback, options); };
  </script><script src="/script/core.min.js">`);
app.get(/.*/, (_req, res) => res.type("html").send(html));
app.listen(4175, "0.0.0.0", () => console.log("Performance fixture: http://localhost:4175"));
