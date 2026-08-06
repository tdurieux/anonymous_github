const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { isScriptableDocument } = require("../src/server/routes/file");

// A repository's own .html/.svg is served from our origin, so anything the
// browser will render as a document (and run script from) has to carry the
// CSP sandbox header — see the comment on the file route.
describe("file route scriptable-document detection", function () {
  it("flags markup the browser renders as a document", function () {
    const scriptable = [
      "index.html",
      "docs/report.htm",
      "page.xhtml",
      "page.xht",
      "figures/plot.svg",
      "data/feed.xml",
      "style.xsl",
      "transform.xslt",
      "archive.mhtml",
    ];
    scriptable.forEach((path) => {
      expect(isScriptableDocument(path), path).to.equal(true);
    });
  });

  it("is case insensitive on the extension", function () {
    expect(isScriptableDocument("README.HTML")).to.equal(true);
    expect(isScriptableDocument("logo.SVG")).to.equal(true);
  });

  it("leaves everything else alone", function () {
    const inert = [
      "README.md",
      "src/index.js",
      "report.pdf",
      "photo.png",
      "notes.txt",
      "data.csv",
      "archive.zip",
      "notebook.ipynb",
    ];
    inert.forEach((path) => {
      expect(isScriptableDocument(path), path).to.equal(false);
    });
  });

  it("does not treat a directory suffix as the file's extension", function () {
    // The extension has to come from the basename, not from anywhere in the
    // path — "svg/logo" is a PNG-less file inside an svg/ directory.
    expect(isScriptableDocument("assets.html/logo")).to.equal(false);
    expect(isScriptableDocument("svg/drawing")).to.equal(false);
  });

  it("ignores files with no extension", function () {
    expect(isScriptableDocument("LICENSE")).to.equal(false);
    expect(isScriptableDocument("docs/Makefile")).to.equal(false);
  });
});
