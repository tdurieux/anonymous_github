const { expect } = require("chai");

/**
 * Tests for AnonymizedFile pure logic: extension(), isImage(),
 * isFileSupported().
 *
 * These methods rely only on the file name / anonymizedPath and
 * repository options, so they can be tested without a database.
 */

// ---------------------------------------------------------------------------
// Replicated logic from src/core/AnonymizedFile.ts
// ---------------------------------------------------------------------------

function extension(filename) {
  const extensions = filename.split(".").reverse();
  return extensions[0].toLowerCase();
}

const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "ico",
  "bmp",
  "tiff",
  "tif",
  "webp",
  "avif",
  "heif",
  "heic",
];

function isImage(filename) {
  const ext = extension(filename);
  return IMAGE_EXTENSIONS.includes(ext);
}

function isFileSupported(filename, options) {
  const ext = extension(filename);
  if (!options.pdf && ext === "pdf") {
    return false;
  }
  if (!options.image && isImage(filename)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnonymizedFile.extension()", function () {
  it("extracts a simple extension", function () {
    expect(extension("file.txt")).to.equal("txt");
  });

  it("extracts the last extension from multi-dot files", function () {
    expect(extension("archive.tar.gz")).to.equal("gz");
  });

  it("lowercases the extension", function () {
    expect(extension("document.PDF")).to.equal("pdf");
    expect(extension("photo.JpEg")).to.equal("jpeg");
  });

  it("handles dotfiles", function () {
    expect(extension(".gitignore")).to.equal("gitignore");
  });

  it("handles files with no extension", function () {
    // "Makefile".split(".").reverse() → ["Makefile"]
    // [0].toLowerCase() → "makefile"
    expect(extension("Makefile")).to.equal("makefile");
  });

  it("handles files with trailing dot", function () {
    // "file.".split(".").reverse() → ["", "file"]
    expect(extension("file.")).to.equal("");
  });

  it("handles deeply nested extensions", function () {
    expect(extension("a.b.c.d.e.f")).to.equal("f");
  });

  it("handles uppercase mixed with numbers", function () {
    expect(extension("data.JSON5")).to.equal("json5");
  });
});

describe("AnonymizedFile.isImage()", function () {
  it("recognizes png as image", function () {
    expect(isImage("photo.png")).to.be.true;
  });

  it("recognizes jpg as image", function () {
    expect(isImage("photo.jpg")).to.be.true;
  });

  it("recognizes jpeg as image", function () {
    expect(isImage("photo.jpeg")).to.be.true;
  });

  it("recognizes gif as image", function () {
    expect(isImage("anim.gif")).to.be.true;
  });

  it("recognizes svg as image", function () {
    expect(isImage("icon.svg")).to.be.true;
  });

  it("recognizes ico as image", function () {
    expect(isImage("favicon.ico")).to.be.true;
  });

  it("recognizes bmp as image", function () {
    expect(isImage("old.bmp")).to.be.true;
  });

  it("recognizes tiff as image", function () {
    expect(isImage("scan.tiff")).to.be.true;
  });

  it("recognizes tif as image", function () {
    expect(isImage("scan.tif")).to.be.true;
  });

  it("recognizes webp as image", function () {
    expect(isImage("web.webp")).to.be.true;
  });

  it("recognizes avif as image", function () {
    expect(isImage("modern.avif")).to.be.true;
  });

  it("recognizes heif as image", function () {
    expect(isImage("apple.heif")).to.be.true;
  });

  it("recognizes heic as image", function () {
    expect(isImage("iphone.heic")).to.be.true;
  });

  it("is case-insensitive", function () {
    expect(isImage("photo.PNG")).to.be.true;
    expect(isImage("photo.Jpg")).to.be.true;
  });

  it("rejects non-image extensions", function () {
    expect(isImage("file.txt")).to.be.false;
    expect(isImage("file.pdf")).to.be.false;
    expect(isImage("file.js")).to.be.false;
    expect(isImage("file.html")).to.be.false;
    expect(isImage("file.md")).to.be.false;
  });

  it("rejects files containing image extension names but with different ext", function () {
    expect(isImage("my-png-converter.exe")).to.be.false;
  });
});

describe("AnonymizedFile.isFileSupported()", function () {
  it("supports all files when all options are enabled", function () {
    const opts = { pdf: true, image: true };
    expect(isFileSupported("file.pdf", opts)).to.be.true;
    expect(isFileSupported("file.png", opts)).to.be.true;
    expect(isFileSupported("file.txt", opts)).to.be.true;
  });

  it("rejects PDF when pdf option is false", function () {
    expect(isFileSupported("file.pdf", { pdf: false, image: true })).to.be
      .false;
  });

  it("accepts PDF when pdf option is true", function () {
    expect(isFileSupported("file.pdf", { pdf: true, image: true })).to.be.true;
  });

  it("rejects images when image option is false", function () {
    expect(isFileSupported("photo.png", { pdf: true, image: false })).to.be
      .false;
    expect(isFileSupported("photo.jpg", { pdf: true, image: false })).to.be
      .false;
    expect(isFileSupported("icon.svg", { pdf: true, image: false })).to.be
      .false;
  });

  it("accepts images when image option is true", function () {
    expect(isFileSupported("photo.png", { pdf: true, image: true })).to.be
      .true;
  });

  it("accepts non-image, non-PDF files regardless of options", function () {
    expect(isFileSupported("file.js", { pdf: false, image: false })).to.be
      .true;
    expect(isFileSupported("file.md", { pdf: false, image: false })).to.be
      .true;
    expect(isFileSupported("file.html", { pdf: false, image: false })).to.be
      .true;
  });

  it("rejects both PDF and images when both are disabled", function () {
    const opts = { pdf: false, image: false };
    expect(isFileSupported("doc.pdf", opts)).to.be.false;
    expect(isFileSupported("pic.png", opts)).to.be.false;
    expect(isFileSupported("code.ts", opts)).to.be.true;
  });

  it("is case-insensitive for PDF", function () {
    expect(isFileSupported("file.PDF", { pdf: false, image: true })).to.be
      .false;
  });

  it("is case-insensitive for images", function () {
    expect(isFileSupported("photo.PNG", { pdf: true, image: false })).to.be
      .false;
  });
});
