# GFM extension fixtures

`gfm-extensions.json` contains the tables, strikethrough, autolink and task-list examples from GitHub's [cmark-gfm extension tests](https://github.com/github/cmark-gfm/blob/27d942c8b0a62d192f616e5bf3578f4b6a89e180/test/extensions.txt), retrieved November 2, 2026. The examples are by Yuki Izumi and contributors and are licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

The Markdown and expected HTML are unchanged. They have been extracted into JSON with their section names. `<IGNORE>` is upstream's crash-only test, not expected rendered HTML. The test normalizes HTML serialization and insignificant block whitespace, and sanitizes expected HTML with the production policy. Footnote links, alerts, math, media and diagrams have separate behavioral assertions in `markdown-compatibility.test.js`.
