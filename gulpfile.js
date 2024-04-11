const { src, dest } = require("gulp");
const uglify = require("gulp-uglify");
const concat = require("gulp-concat");
var order = require("gulp-order");
const cleanCss = require("gulp-clean-css");

function defaultTask(cb) {
  const jsFiles = [
    "public/script/external/angular.min.js",
    "public/script/external/angular-translate.min.js",
    "public/script/external/angular-translate-loader-static-files.min.js",
    "public/script/external/angular-sanitize.min.js",
    "public/script/external/angular-route.min.js",
    "public/script/external/pdf.compat.js",
    "public/script/external/pdf.js",
    "public/script/external/github-emojis.js",
    "public/script/external/marked-emoji.js",
    "public/script/external/marked.min.js",
    "public/script/external/purify.min.js",
    "public/script/external/ansi_up.min.js",
    "public/script/external/prism.min.js",
    "public/script/external/katex.min.js",
    "public/script/external/katex-auto-render.min.js",
    "public/script/external/marked-katex-extension.umd.min.js",
    "public/script/external/notebook.min.js",
    "public/script/external/org.js",
    "public/script/external/jquery-3.4.1.min.js",
    "public/script/external/popper.min.js",
    "public/script/external/bootstrap.min.js",
    "public/script/external/ace/ace.js",
    "public/script/external/ui-ace.min.js",
    "public/script/utils.js",
    "public/script/ng-pdfviewer.min.js",
    "public/script/app.js",
    "public/script/admin.js",
  ];
  const cssFiles = [
    "public/css/bootstrap.min.css",
    "public/css/font-awesome.min.css",
    "public/css/notebook.css",
    "public/css/katex.min.css",
    "public/css/github-markdown.min.css",
    "public/css/style.css",
  ];
  src(jsFiles)
    .pipe(order(jsFiles, { base: "./" }))
    .pipe(concat("bundle.min.js"))
    .pipe(uglify())
    .pipe(dest("public/script"))
    .on("end", cb);

  src(cssFiles)
    .pipe(order(cssFiles, { base: "./" }))
    .pipe(concat("all.min.css"))
    .pipe(cleanCss())
    .pipe(dest("public/css"));
}

exports.default = defaultTask;
