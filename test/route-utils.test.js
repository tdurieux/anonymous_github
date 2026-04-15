const { expect } = require("chai");

/**
 * Tests for route utility functions.
 *
 * We replicate the handleError status-code logic and escapeHtml utility
 * here so we can test them without starting the Express server or
 * connecting to a database.
 */

// ---------------------------------------------------------------------------
// Replicated handleError status derivation logic
// (mirrors src/server/routes/route-utils.ts)
// ---------------------------------------------------------------------------

function deriveHttpStatus(error) {
  let message = error;
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error !== "string") {
    message = String(error);
  }
  let status = 500;
  if (error.httpStatus) {
    status = error.httpStatus;
  } else if (error.$metadata?.httpStatusCode) {
    status = error.$metadata.httpStatusCode;
  } else if (
    message &&
    (message.indexOf("not_found") > -1 || message.indexOf("(Not Found)") > -1)
  ) {
    status = 404;
  } else if (message && message.indexOf("not_connected") > -1) {
    status = 401;
  }
  return status;
}

// ---------------------------------------------------------------------------
// Replicated escapeHtml from webview.ts
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deriveHttpStatus", function () {
  it("returns 500 for a generic error", function () {
    const status = deriveHttpStatus(new Error("something broke"));
    expect(status).to.equal(500);
  });

  it("uses httpStatus when present on the error", function () {
    const err = new Error("bad request");
    err.httpStatus = 400;
    expect(deriveHttpStatus(err)).to.equal(400);
  });

  it("uses $metadata.httpStatusCode for AWS-style errors", function () {
    const err = { $metadata: { httpStatusCode: 403 }, message: "forbidden" };
    expect(deriveHttpStatus(err)).to.equal(403);
  });

  it("returns 404 when message contains not_found", function () {
    expect(deriveHttpStatus(new Error("repo_not_found"))).to.equal(404);
  });

  it("returns 404 when message contains (Not Found)", function () {
    expect(deriveHttpStatus(new Error("GitHub (Not Found)"))).to.equal(404);
  });

  it("returns 401 when message contains not_connected", function () {
    expect(deriveHttpStatus(new Error("not_connected"))).to.equal(401);
  });

  it("prefers httpStatus over message-based detection", function () {
    const err = new Error("not_found");
    err.httpStatus = 503;
    expect(deriveHttpStatus(err)).to.equal(503);
  });

  it("handles plain string error", function () {
    expect(deriveHttpStatus("repo_not_found")).to.equal(404);
  });

  it("handles string error for not_connected", function () {
    expect(deriveHttpStatus("not_connected")).to.equal(401);
  });

  it("returns status from httpStatus on a plain object", function () {
    expect(deriveHttpStatus({ httpStatus: 429 })).to.equal(429);
  });

  it("returns 500 for a plain object without httpStatus", function () {
    expect(deriveHttpStatus({})).to.equal(500);
  });
});

describe("escapeHtml", function () {
  it("escapes ampersands", function () {
    expect(escapeHtml("a&b")).to.equal("a&amp;b");
  });

  it("escapes less-than signs", function () {
    expect(escapeHtml("<script>")).to.equal("&lt;script&gt;");
  });

  it("escapes greater-than signs", function () {
    expect(escapeHtml("a > b")).to.equal("a &gt; b");
  });

  it("escapes double quotes", function () {
    expect(escapeHtml('say "hello"')).to.equal("say &quot;hello&quot;");
  });

  it("escapes single quotes", function () {
    expect(escapeHtml("it's")).to.equal("it&#039;s");
  });

  it("handles a string with all special characters", function () {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).to.equal(
      "&lt;a href=&quot;x&quot; onclick=&#039;y&#039;&gt;&amp;"
    );
  });

  it("returns an empty string unchanged", function () {
    expect(escapeHtml("")).to.equal("");
  });

  it("returns a string with no special characters unchanged", function () {
    expect(escapeHtml("hello world 123")).to.equal("hello world 123");
  });

  it("prevents XSS via file names in directory listing", function () {
    const maliciousName = '<img src=x onerror="alert(1)">';
    const escaped = escapeHtml(maliciousName);
    expect(escaped).to.not.include("<img");
    // The literal string "onerror" still appears in the escaped output,
    // but it is no longer an HTML attribute — it is plain text
    expect(escaped).to.equal(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
    );
  });

  it("prevents XSS via script tags in file names", function () {
    const maliciousName = '<script>alert("xss")</script>';
    const escaped = escapeHtml(maliciousName);
    expect(escaped).to.not.include("<script");
  });
});
