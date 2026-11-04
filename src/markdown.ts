import { Marked, Tokens } from "marked";
const markedFootnote: typeof import("marked-footnote").default = require("marked-footnote");
const markedAlert: typeof import("marked-alert").default = require("marked-alert");
const markedKatex: typeof import("marked-katex-extension").default = require("marked-katex-extension");
import { gfmHeadingId } from "marked-gfm-heading-id";
import * as katex from "katex";
import sanitizeHtml = require("sanitize-html");
const hljs: typeof import("highlight.js/lib/common").default = require("highlight.js/lib/common");
import { renderDiagram } from "./markdown-diagrams";

const emojis: Record<string, string> = require("../public/script/external/github-emojis");
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]!));

function resolveUrl(url: string, base?: string): string {
  if (!base || !url || /^(?:#|\/|[a-z][a-z\d+.-]*:)/i.test(url)) return url;
  try {
    const resolved = new URL(url, new URL(base, "https://markdown.invalid"));
    return /^https?:/i.test(base) ? resolved.href : resolved.pathname + resolved.search + resolved.hash;
  } catch { return url; }
}

/** The browser and project-page route use this same parser and sanitizer. */
export function renderMarkdown(source: string, base?: string): string {
  // Only renderer-generated math/SVG bypasses HTML sanitization. An unpredictable,
  // per-document marker prevents raw HTML from impersonating generated output.
  const nonce = Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join("-");
  const generated: string[] = [];
  const trusted = (html: string) => `<span data-render-token="${nonce}-${generated.push(html) - 1}"></span>`;
  const math = (text: string, displayMode: boolean) => trusted(katex.renderToString(text, {
    displayMode, throwOnError: false, trust: false, maxExpand: 1000, maxSize: 20,
  }));
  const parser = new Marked({ gfm: true, breaks: false, async: false });
  parser.use(markedFootnote(), gfmHeadingId());
  const alerts = markedAlert();
  const topLevelQuotes = new WeakSet();
  const alertWalk = alerts.walkTokens!;
  alerts.walkTokens = function (token) {
    if (topLevelQuotes.has(token)) return alertWalk.call(this, token);
  };
  alerts.hooks = { processAllTokens(tokens) {
    for (const token of tokens) if (token.type === "blockquote") topLevelQuotes.add(token);
    return tokens;
  } };
  // Preserve the extension's fixed icons without admitting arbitrary source SVG.
  for (const extension of alerts.extensions || []) {
    if ("renderer" in extension && extension.renderer) {
      const render = extension.renderer;
      extension.renderer = function (token) {
        const icon = token.meta.icon;
        token.meta.icon = trusted(icon);
        return render.call(this, token);
      };
    }
  }
  parser.use(alerts);
  const mathExtension = markedKatex({ throwOnError: false, nonStandard: true });
  for (const extension of mathExtension.extensions || []) {
    if ("renderer" in extension) extension.renderer = token => math(token.text, token.displayMode);
  }
  parser.use(mathExtension, {
    extensions: [{
      name: "protocolEmail", level: "inline",
      start: src => {
        const match = /(?:^|[\s/])(mailto:|xmpp:)/.exec(src);
        return match ? match.index + match[0].length - match[1].length : undefined;
      },
      tokenizer(src) {
        if (this.lexer.state.inLink) return;
        const match = /^(mailto:|xmpp:)([\w.+-]+@[\w.-]+\.[\w-]+)(\/[^\s<>]*)?/.exec(src);
        if (!match) return;
        const text = (match[1] + match[2] + (match[1] === "xmpp:" ? match[3] || "" : "")).replace(/[.,!?]+$/, "");
        return { type: "protocolEmail", raw: text, text };
      },
      renderer: token => `<a href="${escapeHtml(token.text)}">${escapeHtml(token.text)}</a>`,
    }, {
      name: "githubMath", level: "inline",
      start: src => src.indexOf("$`"),
      tokenizer(src) {
        const match = /^\$`([^\n]*?)`\$/.exec(src);
        if (match) return { type: "githubMath", raw: match[0], text: match[1] };
      },
      renderer: token => math(token.text, false),
    }, {
      name: "emoji", level: "inline", start: src => src.search(/:[\w+-]+:/),
      tokenizer(src) {
        const match = /^:([\w+-]+):/.exec(src);
        if (match && Object.prototype.hasOwnProperty.call(emojis, match[1])) return { type: "emoji", raw: match[0], name: match[1] };
      },
      renderer: token => `<img class="emoji" alt=":${token.name}:" width="20" height="20" src="${emojis[token.name]}">`,
    }],
    tokenizer: {
      url(src) {
        const match = /^(?:https?:\/\/|www\.)[^\s<>]+/.exec(src);
        if (!match) return false;
        const host = match[0].replace(/^https?:\/\//, "").split(/[/?#]/)[0].split(".");
        if (host.slice(-2).some(part => part.includes("_"))) return { type: "link", raw: match[0], text: match[0], href: "", invalidAutolink: true, tokens: [] };
        const unicodeHost = /^https?:\/\//.test(match[0]) && match[0].slice(match[0].indexOf("://") + 3).charCodeAt(0) > 127;
        if (!match[0].startsWith("www._") && !unicodeHost) return false;
        const text = match[0].replace(/[?!.,:*_'"~]+$/, "");
        return { type: "link", raw: text, href: encodeURI(text.startsWith("www.") ? `http://${text}` : text), text, tokens: [{ type: "text", raw: text, text: escapeHtml(text) }] };
      },
    },
    renderer: {
      link(token: Tokens.Link & { invalidAutolink?: boolean }) {
        if (token.invalidAutolink) return escapeHtml(token.text);
        if (/\.(mp4|mov)(?:[?#]|$)/i.test(token.href)) return `<video controls src="${escapeHtml(token.href)}" title="${escapeHtml(token.title || token.text)}">${this.parser.parseInline(token.tokens)}</video>`;
        return false;
      },
      code(token: Tokens.Code) {
        const language = (token.lang || "").split(/\s+/)[0].toLowerCase();
        if (language === "math") return math(token.text, true);
        if (language === "mermaid") return `<pre class="mermaid">${escapeHtml(token.text)}</pre>`;
        if (["geojson", "topojson", "stl"].includes(language)) {
          try { return trusted(renderDiagram(token.text, language)); }
          catch { /* Invalid diagrams retain their readable source. */ }
        }
        if (language && hljs.getLanguage(language)) {
          return `<pre><code class="language-${escapeHtml(language)} hljs">${hljs.highlight(token.text, { language, ignoreIllegals: true }).value}</code></pre>\n`;
        }
        return false;
      },
    },
  });
  const raw = parser.parse(source) as string;
  const clean = sanitizeMarkdownHtml(raw, base);
  return clean.replace(new RegExp(`<span data-render-token="${nonce}-(\\d+)"></span>`, "g"), (_match, index) => generated[Number(index)]);
}

export function sanitizeMarkdownHtml(raw: string, base?: string): string {
  return sanitizeHtml(raw, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "img", "picture", "source", "video", "input", "details", "summary", "del", "ins", "sup", "sub", "kbd", "samp", "var", "ruby", "rt", "rp",
    ]),
    allowedAttributes: {
      "*": ["id", "class", "dir", "lang", "title", "aria-label", "aria-labelledby", "aria-describedby", "aria-hidden", "align"],
      a: ["href", "name", "rel", "data-footnote-ref", "data-footnote-backref"],
      img: ["src", "srcset", "alt", "width", "height", "loading", "align"],
      source: ["src", "srcset", "media", "type"],
      video: ["src", "controls", "width", "height", "poster"],
      input: ["type", "checked", "disabled"],
      details: ["open"], ol: ["start", "reversed"], li: ["value"],
      td: ["align", "colspan", "rowspan"], th: ["align", "colspan", "rowspan", "scope"],
      span: ["data-render-token"], section: ["data-footnotes"],
    },
    allowedSchemes: ["http", "https", "mailto", "xmpp"],
    transformTags: {
      input: (_tag, attrs) => ({ tagName: "input", attribs: { type: "checkbox", disabled: "", ...(Object.prototype.hasOwnProperty.call(attrs, "checked") ? { checked: "" } : {}) } }),
      "*": (tagName, attribs) => {
        if (tagName === "img" && /#gh-(dark|light)-mode-only$/.test(attribs.src || "")) {
          attribs.class = `${attribs.class || ""} ${attribs.src.endsWith("#gh-dark-mode-only") ? "gh-dark-mode-only" : "gh-light-mode-only"}`.trim();
        }
        for (const attr of ["href", "src", "poster"]) if (attribs[attr]) attribs[attr] = resolveUrl(attribs[attr], base);
        if (attribs.srcset) attribs.srcset = attribs.srcset.split(",").map(candidate => {
          const [url, ...descriptor] = candidate.trim().split(/\s+/);
          return [resolveUrl(url, base), ...descriptor].join(" ");
        }).join(", ");
        return { tagName, attribs };
      },
    },
  });
}
