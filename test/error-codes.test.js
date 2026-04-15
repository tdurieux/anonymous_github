const { expect } = require("chai");
const { readFileSync, readdirSync, statSync } = require("fs");
const { join } = require("path");

const LOCALE_PATH = join(__dirname, "..", "public", "i18n", "locale-en.json");
const SRC_DIR = join(__dirname, "..", "src");

/**
 * Collect all .ts files under a directory recursively.
 */
function collectTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Extract error codes from backend source files.
 *
 * Matches patterns such as:
 *   1. new AnonymousError("error_code", ...)        -- thrown errors
 *   2. res.status(NNN).json({ error: "code" })      -- direct responses
 *
 * Only string literals that look like error codes (contain at least one
 * underscore, indicating a snake_case identifier) are extracted.
 */
function extractBackendErrorCodes(files) {
  const codes = new Map(); // code -> [{ file, line }]

  const patterns = [
    // new AnonymousError("code")  -- including across ternary expressions
    // e.g.  new AnonymousError("repo_not_found",
    //       new AnonymousError(condition ? msg : "fallback_code",
    /AnonymousError\([^)]*["']([a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+)["']/,
    // { error: "code" }  -- direct JSON responses
    /\{\s*error:\s*["']([a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+)["']/,
  ];

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    const relPath = file.replace(join(__dirname, "..") + "/", "");

    // Per-line matching for simple cases
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(import |\/\/|\/\*|\* )/.test(line)) continue;

      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
          const code = match[1];
          if (!codes.has(code)) {
            codes.set(code, []);
          }
          codes.get(code).push({ file: relPath, line: i + 1 });
        }
      }
    }

    // Multi-line matching for AnonymousError calls that span lines
    // (e.g. ternary expressions where the string is on the next line)
    const multiLinePattern =
      /AnonymousError\([\s\S]*?["']([a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+)["']/g;
    let m;
    while ((m = multiLinePattern.exec(content)) !== null) {
      const code = m[1];
      const lineNum =
        content.substring(0, m.index + m[0].length).split("\n").length;
      if (!codes.has(code)) {
        codes.set(code, []);
      }
      // Avoid duplicate entries from the per-line pass
      const existing = codes.get(code);
      if (!existing.some((e) => e.file === relPath && e.line === lineNum)) {
        existing.push({ file: relPath, line: lineNum });
      }
    }
  }

  return codes;
}

describe("Error code coverage", function () {
  let localeErrors;
  let backendCodes;

  before(function () {
    const locale = JSON.parse(readFileSync(LOCALE_PATH, "utf-8"));
    localeErrors = locale.ERRORS || {};
    backendCodes = extractBackendErrorCodes(collectTsFiles(SRC_DIR));
  });

  it("locale file is valid JSON with an ERRORS object", function () {
    expect(localeErrors).to.be.an("object").that.is.not.empty;
  });

  it("every backend error code has a frontend translation", function () {
    const missing = [];
    for (const [code, locations] of backendCodes) {
      if (!localeErrors[code]) {
        const where = locations
          .map((l) => `    ${l.file}:${l.line}`)
          .join("\n");
        missing.push(`  "${code}" used in:\n${where}`);
      }
    }
    expect(missing, `Missing translations:\n${missing.join("\n")}`).to.have
      .length(0);
  });

  it("every frontend translation corresponds to a backend error code", function () {
    const unused = [];
    for (const code of Object.keys(localeErrors)) {
      if (!backendCodes.has(code)) {
        unused.push(`  "${code}"`);
      }
    }
    // This is a warning, not a hard failure -- some codes may only be used
    // on the frontend itself (e.g. "unreachable", "request_error").
    // We report them so developers can clean up stale entries.
    if (unused.length > 0) {
      console.log(
        `  ⚠  ${unused.length} locale key(s) not found in backend source (frontend-only or stale):\n${unused.join("\n")}`
      );
    }
  });

  it("locale error messages are non-empty strings", function () {
    const empty = [];
    for (const [code, message] of Object.entries(localeErrors)) {
      if (typeof message !== "string" || message.trim() === "") {
        empty.push(code);
      }
    }
    expect(empty, `Empty/invalid messages for: ${empty.join(", ")}`).to.have
      .length(0);
  });

  it("backend error codes use consistent snake_case format", function () {
    const invalid = [];
    // Allow snake_case with optional camelCase segments (e.g. pullRequestId_not_specified)
    const validPattern = /^[a-zA-Z][a-zA-Z0-9]*(_[a-zA-Z0-9]+)*$/;
    for (const code of backendCodes.keys()) {
      if (!validPattern.test(code)) {
        invalid.push(code);
      }
    }
    expect(
      invalid,
      `Invalid error code format: ${invalid.join(", ")}`
    ).to.have.length(0);
  });
});
