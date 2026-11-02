const fs = require("node:fs");
const path = require("node:path");

// Keep public browser assets covered by the lockfile's dependency audit.
const root = path.resolve(__dirname, "..");
for (const [source, destination] of [
  ["node_modules/mermaid/dist/mermaid.min.js", "public/script/external/mermaid.min.js"],
  ["node_modules/dompurify/dist/purify.min.js", "public/script/external/purify.min.js"],
  ["node_modules/katex/dist/katex.min.js", "public/script/external/katex.min.js"],
  ["node_modules/katex/dist/katex.min.css", "public/css/katex.min.css"],
]) fs.copyFileSync(path.join(root, source), path.join(root, destination));
fs.cpSync(path.join(root, "node_modules/katex/dist/fonts"), path.join(root, "public/css/fonts"), { recursive: true });
