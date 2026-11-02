# Markdown rendering

Repository previews and Markdown project pages use `src/markdown.ts`. The browser build bundles that module into the lazy-loaded `markdown.min.js`; the project-page route calls it directly. Each document gets fresh parser extensions, references and heading IDs.

The compatibility suite covers:

- CommonMark blocks and inline formatting, GFM tables, task lists, strikethrough and autolinks.
- GitHub heading IDs, repeated headings, custom anchors, relative links and images, picture sources, disclosures, keyboard text, subscript and superscript.
- Emoji shortcodes, footnotes with repeated references, and all five GitHub alerts.
- Inline dollar and dollar/backtick math, display math and fenced `math` blocks.
- Syntax highlighting, Mermaid, GeoJSON, TopoJSON and ASCII STL fences. Invalid map/model blocks retain their source.
- Sanitization, escaped syntax, code-block isolation, document-to-document state isolation and browser/server output parity.

Maps render their supplied geometry with zoom controls. STL models support zoom and rotation. These viewers do not reproduce GitHub's map tiles or 3D material controls. Math uses KaTeX rather than GitHub's MathJax, so MathJax-only commands are not guaranteed. Highlighting uses highlight.js's common language bundle; unrecognized languages remain readable code. Mermaid uses the locally shipped version, which may differ from GitHub's deployed version.

GitHub service features such as user mentions, issue-status badges, commit references and attachment uploads require GitHub identity or repository context. The anonymous viewer does not resolve those identities. It also does not execute repository HTML, arbitrary CSS or scripts.

The sanitizer runs on all Markdown-produced HTML. Math and diagram renderers insert their own generated markup through unpredictable, per-document markers after sanitization. TeX runs with `trust: false`; Mermaid runs with `securityLevel: strict`. Source HTML cannot opt into this bypass. Task inputs are always disabled checkboxes.

Run `npm run build:ui` before `npx mocha test/markdown-compatibility.test.js test/markdown-sanitization.test.js test/markdown-security.test.js test/mermaid-security.test.js test/asset-build.test.js`. The browser tests exercise the built bundle, not a copy of the renderer.

References: [GitHub basic syntax](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax), [math](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/writing-mathematical-expressions), [diagrams](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams), and the [GFM specification](https://github.github.com/gfm/).

Diagram inputs are limited to one million characters and 60,000 coordinates. Maps also enforce nesting and TopoJSON expansion limits before conversion. Rejected diagrams display as code.

Mermaid, DOMPurify and KaTeX are npm dependencies so dependency audits cover their versions. After upgrading them, run `npm run vendor:markdown` followed by `npm run build:ui` and commit the refreshed assets. Security tests require the vendored files to match the installed packages.
