const { src, dest, parallel } = require("gulp");
const uglify = require("gulp-uglify");
const concat = require("gulp-concat");
var order = require("gulp-order");
const cleanCss = require("gulp-clean-css");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const coreJsFiles = [
  "public/script/external/angular.min.js",
  "public/script/external/angular-translate.min.js",
  "public/script/external/angular-translate-loader-static-files.min.js",
  "public/script/external/angular-sanitize.min.js",
  "public/script/external/angular-route.min.js",
  "public/script/external/github-emojis.js",
  "public/script/external/marked-emoji.js",
  "public/script/external/marked.min.js",
  "public/script/external/purify.min.js",
  "public/script/external/ansi_up.min.js",
  "public/script/external/prism.min.js",
  "public/script/external/jquery-3.4.1.min.js",
  "public/script/external/popper.min.js",
  "public/script/external/bootstrap.min.js",
  "public/script/utils.js",
];

const vendorJsFiles = [
  "public/script/external/pdf.compat.js",
  "public/script/external/pdf.js",
  "public/script/ng-pdfviewer.min.js",
  "public/script/external/katex.min.js",
  "public/script/external/katex-auto-render.min.js",
  "public/script/external/marked-katex-extension.umd.min.js",
  "public/script/external/marked-mermaid.js",
  "public/script/external/notebook.min.js",
  "public/script/external/org.js",
  "public/script/external/ace/ace.js",
  "public/script/external/ui-ace.min.js",
  "public/script/app.js",
  "public/script/admin.js",
];

const mermaidFiles = [
  "public/script/external/mermaid.min.js",
];

const cssFiles = [
  "public/css/bootstrap.min.css",
  "public/css/font-awesome.min.css",
  "public/css/notebook.css",
  "public/css/katex.min.css",
  "public/css/mermaid.css",
  "public/css/github-markdown.min.css",
  "public/css/style.css",
];

function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("md5").update(content).digest("hex").slice(0, 10);
}

function buildCoreJs(cb) {
  src(coreJsFiles)
    .pipe(order(coreJsFiles, { base: "./" }))
    .pipe(concat("core.min.js"))
    .pipe(uglify())
    .pipe(dest("public/script"))
    .on("end", cb);
}

function buildVendorJs(cb) {
  src(vendorJsFiles)
    .pipe(order(vendorJsFiles, { base: "./" }))
    .pipe(concat("vendor.min.js"))
    .pipe(uglify())
    .pipe(dest("public/script"))
    .on("end", cb);
}

function buildMermaidJs(cb) {
  src(mermaidFiles)
    .pipe(concat("mermaid.min.js"))
    .pipe(dest("public/script"))
    .on("end", cb);
}

function buildCss(cb) {
  src(cssFiles)
    .pipe(order(cssFiles, { base: "./" }))
    .pipe(concat("all.min.css"))
    .pipe(cleanCss())
    .pipe(dest("public/css"))
    .on("end", cb);
}

function writeManifest(cb) {
  const files = {
    "core.min.js": "public/script/core.min.js",
    "vendor.min.js": "public/script/vendor.min.js",
    "mermaid.min.js": "public/script/mermaid.min.js",
    "all.min.css": "public/css/all.min.css",
  };
  const manifest = {};
  for (const [key, filePath] of Object.entries(files)) {
    const hash = hashFile(filePath);
    // Insert hash before the compound extension: core.min.js → core.HASH.min.js
    const firstDot = key.indexOf(".");
    const base = key.slice(0, firstDot);
    const ext = key.slice(firstDot);
    manifest[key] = `${base}.${hash}${ext}`;
  }
  fs.writeFileSync(
    "public/asset-manifest.json",
    JSON.stringify(manifest, null, 2)
  );
  cb();
}

const buildAssets = parallel(buildCoreJs, buildVendorJs, buildMermaidJs, buildCss);

exports.default = function (cb) {
  buildAssets(function () {
    writeManifest(cb);
  });
};
