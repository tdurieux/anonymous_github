const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

/**
 * Regression tests for the dashboard redesign (Sept 2026):
 *  - status codes and raw statuses are rendered as sentences,
 *  - dates spell the month so they are unambiguous across locales,
 *  - the template no longer uses href="#" anchors for actions,
 *  - the theme tokens keep muted text above WCAG AA contrast.
 */

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "public", "css", "style.css"), "utf8");
const html = fs.readFileSync(path.join(root, "public", "partials", "dashboard.htm"), "utf8");

// Exercise the same formatting functions used by the Vue templates.
function loadFilters() {
  const source = fs.readFileSync(path.join(__dirname, "../public/script/formatters.js"), "utf8");
  const names = [...source.matchAll(/export const (\w+)/g)].map(match => match[1]);
  const sandbox = { window: {}, console };
  vm.runInNewContext(source.replace(/export const/g, "var").replace(/export function/g, "function") + "\nthis.formatters = {" + names.join(",") + "};", sandbox);
  return Object.fromEntries(Object.entries(sandbox.formatters).map(([name, fn]) => [name, () => fn]));
}

function contrast(hexA, hexB) {
  const lum = (hex) => {
    const c = hex.replace("#", "").match(/../g).map((x) => parseInt(x, 16) / 255);
    const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const [l1, l2] = [lum(hexA), lum(hexB)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function token(block, name) {
  const m = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  expect(m, `token ${name} not found`).to.not.equal(null);
  return m[1];
}

describe("dashboard UI", function () {
  let filters;
  before(function () {
    filters = loadFilters();
  });

  describe("statusMsg filter", function () {
    it("turns known machine codes into sentences", function () {
      expect(filters.statusMsg()("branch_not_found")).to.equal("Branch not found on GitHub");
    });
    it("turns unknown snake_case codes into a sentence", function () {
      expect(filters.statusMsg()("token_revoked_by_user")).to.equal("Token revoked by user");
    });
    it("leaves free text alone", function () {
      expect(filters.statusMsg()("Something odd happened")).to.equal("Something odd happened");
    });
  });

  describe("statusLabel filter", function () {
    it("labels in-progress statuses as verbs", function () {
      const f = filters.statusLabel();
      expect(f("download")).to.equal("Downloading");
      expect(f("queue")).to.equal("Queued");
      expect(f("ready")).to.equal("Ready");
    });
    it("title-cases unknown statuses", function () {
      expect(filters.statusLabel()("half_done")).to.equal("Half done");
    });
  });

  describe("humanTime filter", function () {
    it("spells the month for dates older than two days", function () {
      const out = filters.humanTime()("2024-03-09T12:00:00Z");
      expect(out).to.match(/^on /);
      expect(out).to.match(/Mar/);
      expect(out).to.not.match(/\d+\/\d+\/\d+/);
    });
    it("keeps relative wording for recent dates", function () {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      expect(filters.humanTime()(twoHoursAgo)).to.equal("2 hours ago");
    });
  });

  describe("template", function () {
    it("uses buttons, not href=\"#\" anchors, for row actions", function () {
      expect(html).to.not.match(/href="#"/);
      expect(html).to.match(/<button type="button" class="dropdown-item dropdown-item-danger"/);
    });
    it("puts the destructive action after a divider", function () {
      const divider = html.indexOf('<div class="dropdown-divider"></div>\n                <button type="button" class="dropdown-item dropdown-item-danger"');
      expect(divider).to.be.greaterThan(-1);
    });
    it("labels hidden statuses as hidden, not as active filters", function () {
      expect(html).to.match(/Hiding \{\{\s*statusKeyLabels\[f\]\s*\}\}/);
    });
    it("shows an unlimited quota without a full bar", function () {
      expect(html).to.match(/quota-fill" v-if="!quota\[q\?\.key\]\.unlimited"/);
      expect(html).to.not.match(/bg-success|bg-warning|bg-danger/);
    });
    it("right-aligns the Views column and marks it sortable", function () {
      expect(html).to.match(/class="num"[^>]*>\s*<button type="button" class="sortable"[^>]*@click="setSort\(&#x27;pageView&#x27;\)"/);
    });
  });

  describe("theme tokens", function () {
    const light = css.slice(css.indexOf("\nbody {"), css.indexOf("--font-serif"));
    const dark = css.slice(css.indexOf(".dark-mode {"), css.indexOf("\nbody {"));

    it("keeps muted text at or above 4.5:1 in light mode", function () {
      expect(contrast(token(light, "--ink-muted"), token(light, "--canvas-bg-color"))).to.be.at.least(4.5);
    });
    it("keeps muted text at or above 4.5:1 in dark mode", function () {
      expect(contrast(token(dark, "--ink-muted"), token(dark, "--canvas-bg-color"))).to.be.at.least(4.5);
    });
    it("keeps status colours at or above 4.5:1 on both canvases", function () {
      for (const [block, name] of [[light, "light"], [dark, "dark"]]) {
        const canvas = token(block, "--canvas-bg-color");
        for (const t of ["--status-ready", "--status-progress", "--status-error"]) {
          expect(contrast(token(block, t), canvas), `${t} in ${name}`).to.be.at.least(4.5);
        }
      }
    });
    it("shows a keyboard focus ring instead of removing outlines", function () {
      expect(css).to.match(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
      expect(css).to.not.match(/\.btn:focus,\s*\.btn:active\s*\{[^}]*outline:\s*none/);
    });
    it("makes the paper palette win over Bootstrap's !important bg utilities", function () {
      expect(css).to.match(/\.progress-bar\.bg-success \{ background: var\(--status-ready\) !important; \}/);
    });
  });
});
