const { src, dest, parallel, series } = require("gulp");
const uglify = require("gulp-uglify");
const concat = require("gulp-concat");
const order = require("ordered-read-streams");
const { pipeline } = require("node:stream");
const cleanCss = require("gulp-clean-css");
const crypto = require("crypto");
const fs = require("fs");
const esbuild = require("esbuild");
const { compileTemplate } = require("vue/compiler-sfc");
const { promisify } = require("node:util");

const coreJsFiles = [
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

const markdownFiles = [
  "public/script/external/katex.min.js",
  "public/script/external/katex-auto-render.min.js",
  "public/script/external/marked-katex-extension.umd.min.js",
  "public/script/external/marked-mermaid.js",
 ];
const pdfFiles = ["public/script/external/pdf.js"];
const notebookFiles = ["public/script/external/notebook.min.js"];
const orgFiles = ["public/script/external/org.js"];
const editorFiles = ["public/script/external/ace/ace.js"];
const lazyGroups = { markdown: markdownFiles, pdf: pdfFiles, notebook: notebookFiles, org: orgFiles, editor: editorFiles };

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

// Gulp 5 does not preserve array order. Read each asset in its declared order
// so libraries precede their plugins and application code, and CSS keeps its cascade.
function orderedSrc(files) {
  return order(files.map(file => src(file)));
}

function buildCoreJs(cb) {
  pipeline(orderedSrc(coreJsFiles), concat("core.min.js"), uglify(), dest("public/script"), cb);
}

async function buildVendorJs() {
  const lazyAssets = {};
  await Promise.all(Object.entries(lazyGroups).map(async ([name, files]) => {
    await promisify(pipeline)(orderedSrc(files), concat(`${name}.min.js`), uglify(), dest("public/script"));
    lazyAssets[name] = `/script/${name}.${hashFile(`public/script/${name}.min.js`)}.min.js`;
  }));
  const app = await esbuild.build({
    entryPoints: ["public/script/main.js"], bundle: true, write: false,
    format: "iife", minify: true, target: "es2020",
    define: { __LAZY_ASSETS__: JSON.stringify(lazyAssets), "process.env.NODE_ENV": JSON.stringify("production"), __VUE_OPTIONS_API__: "true", __VUE_PROD_DEVTOOLS__: "false", __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false" },
    plugins: [{ name: "vue-templates", setup(build) {
      build.onLoad({ filter: /\.htm$/ }, async ({ path }) => {
        const { code, errors } = compileTemplate({
          source: fs.readFileSync(path, "utf8"), filename: path, id: "anonymous",
          compilerOptions: { nodeTransforms: [node => {
            if (node.type === 1 && node.props.some(prop => prop.type === 7 && ["text", "html"].includes(prop.name))) node.children = [];
          }] },
        });
        if (errors.length) throw errors[0];
        return { contents: code, loader: "js" };
      });
    } }],
  });
  fs.writeFileSync("public/script/vendor.min.js", app.outputFiles[0].text);
}

function buildMermaidJs(cb) {
  pipeline(src(mermaidFiles), concat("mermaid.min.js"), dest("public/script"), cb);
}

function buildCss(cb) {
  pipeline(orderedSrc(cssFiles), concat("all.min.css"), cleanCss(), dest("public/css"), cb);
}

function writeManifest(cb) {
  const files = {
    "core.min.js": "public/script/core.min.js",
    "vendor.min.js": "public/script/vendor.min.js",
    "mermaid.min.js": "public/script/mermaid.min.js",
    "all.min.css": "public/css/all.min.css",
  };
  for (const name of Object.keys(lazyGroups)) files[`${name}.min.js`] = `public/script/${name}.min.js`;
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

exports.default = series(buildAssets, writeManifest);
