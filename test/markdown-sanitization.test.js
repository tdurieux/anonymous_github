const { expect } = require("chai");
const { marked } = require("marked");
const DOMPurify = require("isomorphic-dompurify");

/**
 * Helper that mirrors the server-side rendering pipeline in webview.ts:
 *   DOMPurify.sanitize(marked.marked(content, { headerIds: false, mangle: false }))
 */
function renderAndSanitize(markdown) {
  const raw = marked(markdown, { headerIds: false, mangle: false });
  return DOMPurify.sanitize(raw);
}

describe("Markdown sanitization", function () {
  // ---------------------------------------------------------------
  // Script injection
  // ---------------------------------------------------------------
  describe("removes script tags", function () {
    it("strips inline <script> tags", function () {
      const html = renderAndSanitize('<script>alert("xss")</script>');
      expect(html).to.not.include("<script");
      expect(html).to.not.include("alert(");
    });

    it("strips script tags with src attribute", function () {
      const html = renderAndSanitize(
        '<script src="https://evil.com/xss.js"></script>'
      );
      expect(html).to.not.include("<script");
      expect(html).to.not.include("evil.com");
    });

    it("strips script tags embedded in markdown", function () {
      const html = renderAndSanitize(
        "# Hello\n\n<script>document.cookie</script>\n\nWorld"
      );
      expect(html).to.not.include("<script");
      expect(html).to.include("Hello");
      expect(html).to.include("World");
    });
  });

  // ---------------------------------------------------------------
  // Event handler injection
  // ---------------------------------------------------------------
  describe("removes event handlers", function () {
    it("strips onerror handler on img", function () {
      const html = renderAndSanitize('<img src=x onerror="alert(1)">');
      expect(html).to.not.include("onerror");
    });

    it("strips onload handler on img", function () {
      const html = renderAndSanitize(
        '<img src="valid.png" onload="alert(1)">'
      );
      expect(html).to.not.include("onload");
    });

    it("strips onmouseover handler on a tag", function () {
      const html = renderAndSanitize(
        '<a href="#" onmouseover="alert(1)">hover me</a>'
      );
      expect(html).to.not.include("onmouseover");
      expect(html).to.include("hover me");
    });

    it("strips onfocus handler on input", function () {
      const html = renderAndSanitize('<input onfocus="alert(1)" autofocus>');
      expect(html).to.not.include("onfocus");
    });
  });

  // ---------------------------------------------------------------
  // javascript: URLs
  // ---------------------------------------------------------------
  describe("removes javascript: URLs", function () {
    it("strips javascript: href in anchor", function () {
      const html = renderAndSanitize(
        '<a href="javascript:alert(1)">click</a>'
      );
      expect(html).to.not.include("javascript:");
    });

    it("strips javascript: href in markdown link syntax", function () {
      const html = renderAndSanitize("[click](javascript:alert(1))");
      expect(html).to.not.include("javascript:");
    });
  });

  // ---------------------------------------------------------------
  // iframe / object / embed
  // ---------------------------------------------------------------
  describe("removes dangerous elements", function () {
    it("strips iframe", function () {
      const html = renderAndSanitize(
        '<iframe src="https://evil.com"></iframe>'
      );
      expect(html).to.not.include("<iframe");
    });

    it("strips object tag", function () {
      const html = renderAndSanitize(
        '<object data="malware.swf"></object>'
      );
      expect(html).to.not.include("<object");
    });

    it("strips embed tag", function () {
      const html = renderAndSanitize('<embed src="malware.swf">');
      expect(html).to.not.include("<embed");
    });

    it("strips form action with javascript: URL", function () {
      const html = renderAndSanitize(
        '<form action="javascript:alert(1)"><input type="submit"></form>'
      );
      expect(html).to.not.include("javascript:");
    });
  });

  // ---------------------------------------------------------------
  // SVG-based attacks
  // ---------------------------------------------------------------
  describe("removes SVG-based XSS", function () {
    it("strips svg with onload", function () {
      const html = renderAndSanitize('<svg onload="alert(1)">');
      expect(html).to.not.include("onload");
    });

    it("strips svg with embedded script", function () {
      const html = renderAndSanitize(
        "<svg><script>alert(1)</script></svg>"
      );
      expect(html).to.not.include("<script");
    });
  });

  // ---------------------------------------------------------------
  // data: URL attacks
  // ---------------------------------------------------------------
  describe("removes data: URL attacks", function () {
    it("strips data:text/html href", function () {
      const html = renderAndSanitize(
        '<a href="data:text/html,<script>alert(1)</script>">click</a>'
      );
      expect(html).to.not.include("data:text/html");
    });
  });

  // ---------------------------------------------------------------
  // style-based attacks
  // ---------------------------------------------------------------
  describe("removes style-based attacks", function () {
    it("strips style tags with expressions", function () {
      const html = renderAndSanitize(
        "<style>body { background: url('javascript:alert(1)') }</style>"
      );
      expect(html).to.not.include("javascript:");
    });
  });

  // ---------------------------------------------------------------
  // Safe content is preserved
  // ---------------------------------------------------------------
  describe("preserves safe markdown content", function () {
    it("preserves headings", function () {
      const html = renderAndSanitize("# Heading 1\n## Heading 2");
      expect(html).to.include("<h1>");
      expect(html).to.include("Heading 1");
      expect(html).to.include("<h2>");
    });

    it("preserves paragraphs", function () {
      const html = renderAndSanitize("Hello world\n\nSecond paragraph");
      expect(html).to.include("<p>");
      expect(html).to.include("Hello world");
    });

    it("preserves bold and italic", function () {
      const html = renderAndSanitize("**bold** and *italic*");
      expect(html).to.include("<strong>bold</strong>");
      expect(html).to.include("<em>italic</em>");
    });

    it("preserves links", function () {
      const html = renderAndSanitize("[example](https://example.com)");
      expect(html).to.include("https://example.com");
      expect(html).to.include("example");
    });

    it("preserves images", function () {
      const html = renderAndSanitize(
        "![alt](https://example.com/img.png)"
      );
      expect(html).to.include("<img");
      expect(html).to.include("https://example.com/img.png");
    });

    it("preserves code blocks", function () {
      const html = renderAndSanitize("```js\nconsole.log('hi')\n```");
      expect(html).to.include("<code");
      expect(html).to.include("console.log");
    });

    it("preserves inline code", function () {
      const html = renderAndSanitize("Use `npm install` to install");
      expect(html).to.include("<code>npm install</code>");
    });

    it("preserves unordered lists", function () {
      const html = renderAndSanitize("- item 1\n- item 2\n- item 3");
      expect(html).to.include("<ul>");
      expect(html).to.include("<li>");
      expect(html).to.include("item 1");
    });

    it("preserves ordered lists", function () {
      const html = renderAndSanitize("1. first\n2. second");
      expect(html).to.include("<ol>");
      expect(html).to.include("first");
    });

    it("preserves blockquotes", function () {
      const html = renderAndSanitize("> This is a quote");
      expect(html).to.include("<blockquote>");
      expect(html).to.include("This is a quote");
    });

    it("preserves tables", function () {
      const html = renderAndSanitize("| A | B |\n|---|---|\n| 1 | 2 |");
      expect(html).to.include("<table>");
      expect(html).to.include("<th>");
      expect(html).to.include("<td>");
    });

    it("preserves horizontal rules", function () {
      const html = renderAndSanitize("---");
      expect(html).to.include("<hr");
    });
  });

  // ---------------------------------------------------------------
  // Mixed: malicious + safe content
  // ---------------------------------------------------------------
  describe("handles mixed content", function () {
    it("strips malicious parts while keeping safe parts", function () {
      const html = renderAndSanitize(
        '# Title\n\nSafe paragraph.\n\n<script>alert("xss")</script>\n\n**Bold text**'
      );
      expect(html).to.not.include("<script");
      expect(html).to.include("Title");
      expect(html).to.include("Safe paragraph");
      expect(html).to.include("<strong>Bold text</strong>");
    });

    it("strips event handlers from otherwise-safe tags", function () {
      const html = renderAndSanitize(
        '<img src="photo.jpg" alt="photo" onerror="alert(1)">'
      );
      expect(html).to.not.include("onerror");
      expect(html).to.include("photo.jpg");
      expect(html).to.include('alt="photo"');
    });
  });
});
