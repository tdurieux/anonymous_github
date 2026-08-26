const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

/**
 * Regression test for the dashboard "Conference" column overflowing into
 * the "Status" column.
 *
 * Root cause: `.cell-conf` is a CSS grid item with the default
 * `min-width: auto`, so an unbreakable long string (e.g. a conference URL)
 * forces the grid track wider than its `minmax(140px, 1fr)` track size,
 * visually bleeding into the next cell instead of being clipped.
 */

const cssPath = path.join(__dirname, "..", "public", "css", "style.css");
const htmlPath = path.join(__dirname, "..", "public", "partials", "dashboard.htm");

function getRuleBody(css, selector) {
  const index = css.indexOf(selector);
  expect(index, `selector "${selector}" not found in style.css`).to.be.greaterThan(-1);
  const start = css.indexOf("{", index);
  const end = css.indexOf("}", start);
  return css.slice(start + 1, end);
}

describe("dashboard .cell-conf overflow fix", function () {
  const css = fs.readFileSync(cssPath, "utf8");

  it("clips overflowing conference text instead of letting it bleed into other cells", function () {
    const rule = getRuleBody(css, ".paper-table .cell-conf {");
    expect(rule).to.match(/min-width:\s*0/);
    expect(rule).to.match(/overflow:\s*hidden/);
    expect(rule).to.match(/text-overflow:\s*ellipsis/);
    expect(rule).to.match(/white-space:\s*nowrap/);
  });

  it("keeps the fix in the stacked mobile layout too", function () {
    const mobileSectionStart = css.indexOf("@media (max-width: 900px)");
    const mobileRule = getRuleBody(css.slice(mobileSectionStart), ".paper-table .cell-conf {");
    expect(mobileRule).to.match(/overflow:\s*hidden/);
    expect(mobileRule).to.match(/text-overflow:\s*ellipsis/);
    expect(mobileRule).to.match(/white-space:\s*nowrap/);
  });

  it("exposes the full conference value via a title attribute for truncated text", function () {
    const html = fs.readFileSync(htmlPath, "utf8");
    expect(html).to.match(/cell-conf[\s\S]*?title="\{\{item\.conference\}\}"/);
  });
});
