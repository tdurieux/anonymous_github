import { nextTick, markRaw } from "vue";
import { createTimers, createListeners } from "./state.js";
import { slotRedactions } from "./app.js";

// Used by the reviewer page and the author's preview with pageView.htm.
export const setupFileViewer = function (state, events = state) {
  const REDACTION_RE = /\bXXXX-\d+\b/g;
  events.on("dark-mode", (event, on) => {
    if (state.aceOption) state.aceOption.theme = on ? "nord_dark" : "chrome";
  });
  const timers = createTimers();
  const listen = createListeners();
  state.isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const extensionModes = {
    yml: "yaml",
    txt: "text",
    py: "python",
    js: "javascript",
    ts: "typescript",
  };
  const textFiles = ["license", "txt"];
  const imageFiles = [
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
  const audioFiles = ["wav", "mp3", "ogg", "wma", "flac", "aac", "m4a"];
  const mediaFiles = [
    "mp4",
    "avi",
    "webm",
    "mov",
    "mpg",
    "mpeg",
    "mkv",
    "flv",
    "wmv",
    "3gp",
    "3g2",
    "m4v",
    "f4v",
    "f4p",
    "f4a",
    "f4b",
  ];

  // Defined as methods rather than inline `showSource = !showSource` in the
  // template: the toolbar and the file view sit in different child scopes,
  // so an inline assignment would shadow the value on one of them instead
  // of updating the controller's.
  state.toggleSource = function () {
    state.showSource = !state.showSource;
  };

  state.toggleAllowScripts = function () {
    state.allowScripts = !state.allowScripts;
  };

  // Wrap on wide screens; on phones code scrolls sideways so tokens stay intact.
  const storedWrap = (() => { try { return window.localStorage?.getItem("wrapLines"); } catch { return null; } })();
  state.wrapLines = (storedWrap ?? (window.matchMedia?.("(max-width: 767px)").matches ? "false" : "true")) !== "false";
  state.toggleWrap = function () {
    state.wrapLines = !state.wrapLines;
    try { window.localStorage?.setItem("wrapLines", String(state.wrapLines)); } catch { /* storage unavailable */ }
    state.codeEditor?.session.setUseWrapMode(state.wrapLines);
  };
  // Find opens as an overlay at the top right of the code, like an editor.
  // Find on rendered Markdown pages: highlight matches inside the reading column.
  function mdFindRoot() { return window.document.querySelector(".reading-layout .markdown-body"); }
  function clearMdFind() {
    const root = mdFindRoot();
    if (!root) return;
    root.querySelectorAll("mark.md-find").forEach((m) => { m.replaceWith(window.document.createTextNode(m.textContent)); });
    root.normalize();
  }
  state.runMdFind = function () {
    clearMdFind();
    state.mdFindTotal = 0;
    state.mdFindIndex = 0;
    const q = (state.mdFindQuery || "").trim();
    const root = mdFindRoot();
    if (!q || !root) return;
    const cs = !!state.mdFindCase;
    const needle = cs ? q : q.toLowerCase();
    const walker = window.document.createTreeWalker(root, 4);
    const nodes = [];
    while (walker.nextNode()) if ((cs ? walker.currentNode.nodeValue : walker.currentNode.nodeValue.toLowerCase()).includes(needle)) nodes.push(walker.currentNode);
    let total = 0;
    for (const node of nodes) {
      const text = node.nodeValue, lower = cs ? text : text.toLowerCase();
      const frag = window.document.createDocumentFragment();
      let last = 0, i;
      while ((i = lower.indexOf(needle, last)) !== -1) {
        frag.appendChild(window.document.createTextNode(text.slice(last, i)));
        const m = window.document.createElement("mark");
        m.className = "md-find";
        m.textContent = text.slice(i, i + q.length);
        frag.appendChild(m);
        total++;
        last = i + q.length;
      }
      frag.appendChild(window.document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
    state.mdFindTotal = total;
    if (total) state.stepMdFind(0);
  };
  state.stepMdFind = function (delta) {
    const root = mdFindRoot();
    if (!root || !state.mdFindTotal) return;
    const marks = root.querySelectorAll("mark.md-find");
    state.mdFindIndex = (state.mdFindIndex + delta + marks.length) % marks.length;
    marks.forEach((m, i) => m.classList.toggle("is-current", i === state.mdFindIndex));
    marks[state.mdFindIndex]?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  state.toggleMdFind = function (open) {
    state.mdFindOpen = open === undefined ? !state.mdFindOpen : open;
    if (!state.mdFindOpen) { clearMdFind(); state.mdFindTotal = 0; return; }
    nextTick(() => window.document.querySelector(".md-find-input")?.focus());
  };
  state.findInFile = function () {
    const editor = state.codeEditor;
    if (!editor) return;
    editor.focus();
    editor.execCommand("find");
    // Docked under the toolbar: push the code down while the find bar is open.
    const dock = () => {
      const box = editor.searchBox?.element;
      if (!box) return;
      editor.renderer.setScrollMargin(52, 12, 0, 0);
      if (box._dockObserver) return;
      box._dockObserver = new MutationObserver(() => {
        editor.renderer.setScrollMargin(box.style.display !== "none" ? 52 : 12, 12, 0, 0);
      });
      box._dockObserver.observe(box, { attributes: true, attributeFilter: ["style"] });
    };
    dock();
    setTimeout(dock, 150);
  };
  // Lightweight outline: top-level classes, functions and exported constants.
  const symbolPatterns = [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "function"],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/, "function"],
    [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, "function"],
    [/^\s*class\s+([A-Za-z_]\w*)/, "class"],
    [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, "function"],
    [/^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/, "function"],
    [/^\s*(?:public|private|protected|static|\s)+[\w<>\[\],\s]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/, "function"],
  ];
  let symbolCache = { content: null, list: [] };
  state.symbolsOpen = false;
  state.symbols = function () {
    if (typeof state.content !== "string" || state.content.length > 2_000_000) return [];
    if (symbolCache.content === state.content) return symbolCache.list;
    const list = [];
    state.content.split("\n").forEach((text, index) => {
      for (const [re, kind] of symbolPatterns) {
        const m = re.exec(text);
        if (m && !/^(if|for|while|switch|return|catch)$/.test(m[1])) { list.push({ name: m[1], kind, line: index + 1 }); break; }
      }
    });
    symbolCache = { content: state.content, list: list.slice(0, 300) };
    return symbolCache.list;
  };
  state.goToSymbol = function (line) {
    state.symbolsOpen = false;
    const editor = state.codeEditor;
    if (!editor) return;
    editor.scrollToLine(line - 1, true, true, () => {});
    editor.gotoLine(line, 0, true);
    window.history.replaceState(null, "", window.location.pathname + window.location.search + "#L" + line);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };

  // Go to line: a small popover in the file header (Ace's own prompt ignores the site theme).
  state.gotoLine = function () {
    if (!state.codeEditor) return;
    state.moreOpen = false;
    state.gotoError = "";
    state.gotoValue = String(state.codeEditor.getCursorPosition().row + 1);
    state.gotoOpen = true;
    setTimeout(() => { const el = window.document.getElementById("goto-input"); if (el) { el.focus(); el.select(); } }, 0);
  };
  state.closeGoto = function () {
    state.gotoOpen = false;
    state.gotoError = "";
    state.codeEditor?.focus();
  };
  state.submitGoto = function () {
    const editor = state.codeEditor;
    if (!editor) return;
    const m = /^\s*:?\s*(\d+)\s*(?:[:,]\s*(\d+))?\s*$/.exec(state.gotoValue || "");
    const lines = editor.session.getLength();
    if (!m || +m[1] < 1 || +m[1] > lines) { state.gotoError = "Enter a line from 1 to " + lines; return; }
    editor.gotoLine(+m[1], m[2] ? Math.max(0, +m[2] - 1) : 0, true);
    state.gotoOpen = false;
    state.gotoError = "";
    editor.focus();
  };
  // Root listing above the README: folders first, then files.
  state.rootEntries = function () {
    return [...(state.files || [])].sort((a, b) => {
      const af = a.size == null, bf = b.size == null;
      if (af !== bf) return af ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  };
  state.formatSize = function (bytes) {
    if (bytes == null) return "";
    if (bytes < 1024) return bytes + " B";
    const kb = bytes / 1024;
    const one = (n) => n.toFixed(1).replace(/\.0$/, "");
    return kb < 1024 ? one(kb) + " KB" : kb < 1024 * 1024 ? one(kb / 1024) + " MB" : one(kb / 1024 / 1024) + " GB";
  };
  state.fileSize = function (path) {
    if (!path) return null;
    const clean = path.replace(/^\/+/, "");
    const entry = (state.files || []).find((f) => (f.path ? f.path + "/" : "") + f.name === clean);
    return entry && entry.size != null ? entry.size : null;
  };
  state.revealFolder = function (name) {
    state.sidebarHidden = false;
    state.sidebarCollapsed = false;
    nextTick(() => {
      const link = window.document.querySelector('.files a[data-path="/' + (window.CSS?.escape ? window.CSS.escape(name) : name) + '"]');
      if (!link) return;
      if (!link.closest("li")?.classList.contains("open")) link.click();
      link.scrollIntoView({ block: "nearest" });
      link.focus();
    });
  };
  // Notebooks: count the same markers in cell sources and text outputs (not in the JSON keys or image data).
  let nbCount = { content: null, n: 0 };
  const notebookRedactions = (content) => {
    if (nbCount.content === content) return nbCount.n;
    let nb = content;
    if (typeof nb === "string") { try { nb = JSON.parse(nb); } catch { nb = null; } }
    const texts = [];
    const add = (v) => { if (Array.isArray(v)) texts.push(v.join("")); else if (typeof v === "string") texts.push(v); };
    ((nb && (nb.cells || (nb.worksheets || []).flatMap((w) => w.cells || []))) || []).forEach((cell) => {
      add(cell?.source ?? cell?.input);
      (cell?.outputs || []).forEach((o) => {
        add(o?.text);
        if (o?.data) { add(o.data["text/plain"]); add(o.data["text/markdown"]); add(o.data["text/html"]); }
        add(o?.traceback);
      });
    });
    const n = texts.reduce((sum, t) => sum + (t.match(REDACTION_RE) || []).length, 0);
    nbCount = { content, n };
    return n;
  };
  state.redactionCount = function () {
    if (state.type === "IPython") return notebookRedactions(state.content);
    if (typeof state.content !== "string") return 0;
    const text = state.type === "html" ? state.content.replace(/<[^>]*>/g, " ") : state.content;
    return (text.match(REDACTION_RE) || []).length;
  };
  state.renderRedacted = slotRedactions;
  // Reading mode: slugged heading ids + an "On this page" outline (like Mintlify/Stripe docs).
  const slug = (t) => t.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").slice(0, 60) || "section";
  state.renderReadme = function (html) {
    const out = state.renderRedacted(html);
    if (!out || typeof window.DOMParser !== "function") return out;
    const doc = new window.DOMParser().parseFromString("<div>" + out + "</div>", "text/html");
    const seen = {};
    doc.querySelectorAll("h1, h2, h3").forEach((h) => {
      let id = h.id || slug(h.textContent);
      if (seen[id]) id += "-" + (++seen[id]); else seen[id] = 1;
      h.id = id;
    });
    return doc.body.firstChild.innerHTML;
  };
  let tocCache = { content: null, list: [] };
  state.readmeToc = function () {
    if (state.type !== "html" || typeof state.content !== "string") return [];
    if (tocCache.content === state.content) return tocCache.list;
    const doc = new window.DOMParser().parseFromString("<div>" + state.renderReadme(state.sanitize ? state.sanitize(state.content) : state.content) + "</div>", "text/html");
    const list = [...doc.querySelectorAll("h2, h3")].map((h) => ({ id: h.id, text: h.textContent.trim(), level: h.tagName === "H3" ? 3 : 2 })).slice(0, 40);
    tocCache = { content: state.content, list };
    return list;
  };
  state.activeHeading = null;
  listen(window, "scroll", () => {
    const toc = state.readmeToc ? state.readmeToc() : [];
    if (!toc.length) return;
    // Active = the first heading visible below the sticky chrome; if none is on screen,
    // the last heading already scrolled past (the reader is inside that section).
    const chrome = 150;
    let current = "", firstVisible = "";
    for (const h of toc) {
      const el = window.document.getElementById(h.id);
      if (!el) continue;
      const top = el.getBoundingClientRect().top;
      if (top < chrome) current = h.id;
      else if (!firstVisible && top < window.innerHeight - 80) firstVisible = h.id;
    }
    if (firstVisible) current = firstVisible;
    if (state.activeHeading !== current) state.activeHeading = current;
  }, { capture: true, passive: true });
  state.scrollToHeading = function (id) {
    if (!id) {
      const sc = window.document.querySelector(".explorer-content, .file-card-body, .main-pane");
      (sc || window).scrollTo({ top: 0, behavior: "smooth" });
      state.activeHeading = "";
      return;
    }
    const el = window.document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    state.activeHeading = id;
  };
  // CSV/TSV files up to 1 MB render as a table (sticky header, rules, tabular
  // figures) with a Raw toggle back to the code view.
  state.csvView = "table";
  let csvCache = { content: null, rows: [] };
  const parseDelimited = (text, sep) => {
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
        else cell += ch;
      } else if (ch === '"' && cell === "") quoted = true;
      else if (ch === sep) { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.length > 1 || r[0] !== "");
  };
  state.isCsv = () => typeof state.content === "string" && state.type !== "html"
    && /\.(csv|tsv)$/i.test(state.filePath || "") && state.content.length <= 1024 * 1024;
  state.csvRows = () => {
    if (csvCache.content !== state.content) {
      const sep = /\.tsv$/i.test(state.filePath || "") ? "\t" : ",";
      csvCache = { content: state.content, rows: parseDelimited(state.content, sep) };
    }
    return csvCache.rows;
  };
  state.csvNumCol = (ci) => {
    const rows = state.csvRows().slice(1).map((r) => r[ci]).filter((v) => v != null && String(v).trim() !== "");
    return rows.length > 0 && rows.every((v) => state.csvNumeric(v));
  };
  state.csvNumeric = (value) => /^\s*[-+]?(\d[\d,]*)?(\.\d+)?(e[-+]?\d+)?%?\s*$/i.test(value) && /\d/.test(value);
  state.redactParts = function (text) {
    const out = []; let last = 0; let m; const re = /\bXXXX-(\d+)\b/g;
    text = String(text || "");
    while ((m = re.exec(text))) { if (m.index > last) out.push({ t: text.slice(last, m.index) }); out.push({ n: m[1] }); last = m.index + m[0].length; }
    if (last < text.length) out.push({ t: text.slice(last) });
    return out;
  };
  state.pathCopied = false;
  state.copyPath = async function () {
    if (!window.navigator.clipboard?.writeText) return;
    await window.navigator.clipboard.writeText(state.filePath || "");
    state.pathCopied = true;
    setTimeout(() => { state.pathCopied = false; }, 1600);
  };
  state.contentCopied = false;
  state.copyContent = async function () {
    if (typeof state.content !== "string" || !window.navigator.clipboard?.writeText) return;
    // Rendered Markdown: copy the source, not the HTML.
    let text = state.content;
    if (state.type === "html" && state.url) {
      if (state.preview) text = state.sourceContent;
      else try { text = await (await window.fetch(state.url, { credentials: "same-origin" })).text(); } catch (_) { return; }
    }
    await window.navigator.clipboard.writeText(text);
    state.contentCopied = true;
    setTimeout(() => { state.contentCopied = false; }, 1600);
  };

  function getMode(extension) {
    if (extensionModes[extension]) {
      return extensionModes[extension];
    }
    return extension;
  }

  function getType(extension) {
    if (extension == "pdf") {
      return "pdf";
    }
    // Rendered as a document in a sandboxed frame rather than as source —
    // see html-doc.js. "html" is reserved for markup we generated
    // ourselves (rendered markdown/org) and inject directly.
    if (extension == "html" || extension == "htm") {
      return "html-doc";
    }
    if (["md", "markdown", "mdown", "mkdn", "mdx"].includes(extension)) {
      return "md";
    }
    if (extension == "org") {
      return "org";
    }
    if (extension == "ipynb") {
      return "IPython";
    }
    if (textFiles.indexOf(extension) > -1) {
      return "text";
    }
    if (imageFiles.indexOf(extension) > -1) {
      return "image";
    }
    if (mediaFiles.indexOf(extension) > -1) {
      return "media";
    }
    if (audioFiles.indexOf(extension) > -1) {
      return "audio";
    }
    return "code";
  }

  state.downloadUrl = () => state.preview ? state.url : state.url + "&download=true";
  state.prepareFile = function (path) {
    state.showSource = false;
    state.allowScripts = false;
    state.imageSize = "";
    state.filePath = path;
    state.paths = path.split("/").filter(Boolean);
    let extension = state.filePath.toLowerCase();
    const extensionIndex = extension.lastIndexOf(".");
    if (extensionIndex > -1) {
      extension = extension.substring(extensionIndex + 1);
    }

    const languageNames = { javascript: "JavaScript", typescript: "TypeScript", tsx: "TSX", jsx: "JSX", python: "Python", java: "Java", c_cpp: "C/C++", csharp: "C#", golang: "Go", rust: "Rust", ruby: "Ruby", php: "PHP", html: "HTML", css: "CSS", scss: "SCSS", json: "JSON", yaml: "YAML", markdown: "Markdown", sh: "Shell", dockerfile: "Dockerfile", xml: "XML", sql: "SQL", kotlin: "Kotlin", swift: "Swift", scala: "Scala", r: "R", julia: "Julia", latex: "LaTeX", toml: "TOML", csv: "CSV", tsv: "TSV", text: "" };
    const detectedMode = getMode(extension);
    state.languageName = languageNames[detectedMode] ?? (detectedMode ? detectedMode.charAt(0).toUpperCase() + detectedMode.slice(1) : "");
    state.aceOption = {
      readOnly: true,
      useWrapMode: true,
      showGutter: true,
      theme: "chrome",
      useSoftTab: true,
      tabSize: 2,
      fontSize: window.matchMedia?.("(max-width: 767px)").matches ? 12 : 13,
      keyBinding: "vscode",
      fullLineSelection: true,
      highlightActiveLine: false,
      highlightGutterLine: false,
      cursor: "hide",
      showInvisibles: false,
      showIndentGuides: false,
      showPrintMargin: false,
      highlightSelectedWord: false,
      enableBehaviours: true,
      fadeFoldWidgets: false,
      mode: getMode(extension),

      onLoad: function (_editor) {
        state.codeEditor = markRaw(_editor);
        {
          // Render each XXXX-n as its own "redacted" token so the text layer
          // draws it exactly like the Markdown chip (teal text on a teal tint).
          const session = _editor.session;
          const origGetTokens = session.getTokens.bind(session);
          const re = /\bXXXX-\d+\b/g;
          session.getTokens = function (row) {
            const tokens = origGetTokens(row);
            if (!tokens.some((t) => t.value.indexOf("XXXX-") !== -1)) return tokens;
            const out = [];
            for (const t of tokens) {
              if (t.value.indexOf("XXXX-") === -1) { out.push(t); continue; }
              let last = 0;
              re.lastIndex = 0;
              let m;
              while ((m = re.exec(t.value))) {
                if (m.index > last) out.push({ type: t.type, value: t.value.slice(last, m.index) });
                out.push({ type: "redacted.n" + m[0].slice(5), value: m[0] });
                last = m.index + m[0].length;
              }
              if (last < t.value.length) out.push({ type: t.type, value: t.value.slice(last) });
            }
            return out;
          };
          // Each redacted token shows its term number inside the slot.
          if (!window.document.getElementById("redact-index-rules")) {
            const st = window.document.createElement("style");
            st.id = "redact-index-rules";
            st.textContent = Array.from({ length: 99 }, (_, i) => `.ace_redacted.ace_n${i + 1}::after{content:"${i + 1}"}`).join("");
            window.document.head.appendChild(st);
          }
          _editor.renderer.updateFull(true);
        }
        _editor.session.setUseWrapMode(state.wrapLines !== false);
        // The right-edge fade is a cue only while there is more code to the right.
        const card = _editor.container.closest?.(".file-card");
        const syncEdge = () => {
          if (!card) return;
          const r = _editor.renderer;
          const max = (r.layerConfig?.width || 0) - (r.$size?.scrollerWidth || 0);
          card.classList.toggle("at-right-edge", max <= 2 || r.getScrollLeft() >= max - 2);
        };
        _editor.session.on("changeScrollLeft", syncEdge);
        _editor.renderer.on("afterRender", syncEdge);
        // On phones code scrolls sideways; keep the scrollbar visible as a cue.
        if (window.matchMedia?.("(max-width: 767px)").matches) _editor.setOption("hScrollBarAlwaysVisible", true);
        const Range = ace.require("ace/range").Range;
        let activeLineMarker = null;

        function highlightLines(from, to) {
          if (activeLineMarker !== null) {
            _editor.session.removeMarker(activeLineMarker);
            activeLineMarker = null;
          }
          if (from === null || from === undefined) return;
          activeLineMarker = _editor.session.addMarker(
            new Range(from, 0, to, 1),
            "highlighted-line",
            "fullLine"
          );
        }

        function applyHashFromUrl(scroll) {
          const m = !state.preview && window.location.hash.match(/^#L(\d+)(?:-L(\d+))?/);
          if (!m) {
            highlightLines(null);
            return;
          }
          const from = parseInt(m[1]) - 1;
          const to = m[2] ? parseInt(m[2]) - 1 : from;
          highlightLines(from, to);
          if (scroll) {
            timers.timeout(() => {
              _editor.scrollToLine(from, true, true, function () {});
            }, 100);
          }
        }

        applyHashFromUrl(true);

        // #392 — clicking a gutter line updates the URL to #L<n> and
        // shift-clicking extends to #L<from>-L<to> so the user can copy
        // a stable link to a specific line. Use replaceState to avoid
        // polluting history with every click.
        let anchorRow = null;
        _editor.on("guttermousedown", function (e) {
          const row = e.getDocumentPosition().row;
          const shift = e.domEvent && e.domEvent.shiftKey;
          let from = row;
          let to = row;
          if (shift && anchorRow !== null) {
            from = Math.min(anchorRow, row);
            to = Math.max(anchorRow, row);
          } else {
            anchorRow = row;
          }
          const hash =
            from === to
              ? `#L${from + 1}`
              : `#L${from + 1}-L${to + 1}`;
          const url =
            window.location.pathname + window.location.search + hash;
          // The preview highlights lines without touching the form's URL.
          if (!state.preview) window.history.replaceState(null, "", url);
          highlightLines(from, to);
          e.stop();
        });

        const removeHashListener = listen(window, "hashchange", () => applyHashFromUrl(false));

        _editor.setFontSize(state.aceOption.fontSize);
        _editor.setOptions({
          fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
        });
        _editor.container.style.lineHeight = "20px";
        _editor.renderer.setPadding(16);
        _editor.renderer.setScrollMargin(12, 12, 0, 0);
        _editor.renderer.updateFontSize();
        _editor.setReadOnly(state.aceOption.readOnly);
        _editor.setKeyboardHandler(state.aceOption.keyBinding);
        _editor.setSelectionStyle(
          state.aceOption.fullLineSelection ? "line" : "text"
        );
        _editor.setOption("displayIndentGuides", false);
        _editor.setHighlightActiveLine(
          state.aceOption.highlightActiveLine
        );
        if (state.aceOption.cursor == "hide") {
          _editor.renderer.$cursorLayer.element.style.display = "none";
        }
        _editor.setHighlightGutterLine(
          state.aceOption.highlightGutterLine
        );
        _editor.setShowInvisibles(state.aceOption.showInvisibles);
        _editor.setDisplayIndentGuides(state.aceOption.showIndentGuides);

        _editor.renderer.setShowPrintMargin(
          state.aceOption.showPrintMargin
        );
        _editor.setHighlightSelectedWord(
          state.aceOption.highlightSelectedWord
        );
        _editor.session.setUseSoftTabs(state.aceOption.useSoftTab);
        _editor.session.setTabSize(state.aceOption.tabSize);
        _editor.setBehavioursEnabled(state.aceOption.enableBehaviours);
        _editor.setFadeFoldWidgets(state.aceOption.fadeFoldWidgets);
        // Ctrl/Cmd+F searches inside the file (Ace searchbox), like GitHub's blob view.
        // In the preview the shortcuts apply only while the code has focus, so
        // the form keeps the browser's own Find.
        const ownsShortcuts = () => !state.preview || _editor.isFocused();
        const removeFindListener = listen(window, "keydown", (event) => {
          if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "g" && document.body.contains(_editor.container) && ownsShortcuts()) {
            event.preventDefault();
            state.gotoLine();
            return;
          }
          if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "z" && document.body.contains(_editor.container) && ownsShortcuts()) {
            event.preventDefault();
            state.toggleWrap();
            return;
          }
          if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f" && document.body.contains(_editor.container) && ownsShortcuts()) {
            event.preventDefault();
            state.findInFile();
          }
        });
        return () => { removeHashListener(); removeFindListener(); };
      },
    };
    if (state.isDarkMode) {
      state.aceOption.theme = "nord_dark";
    }
    state.type = getType(extension);
  };
  state.renderFileContent = function (content, type, baseUrl, contentType) {
          state.type = type;
          state.content = content;
          state.sourceContent = content;
          if (state.content == "") {
            state.content = null;
          }

          if (state.type == "md") {
            state.content = renderMD(content, baseUrl);
            state.type = "html";
          }
          if (state.type == "org") {
            const orgSource = contentAbs2Relative(content);

            const orgParser = new Org.Parser();
            const orgDocument = orgParser.parse(orgSource);
            var orgHTMLDocument = orgDocument.convert(Org.ConverterHTML, {
              headerOffset: 1,
              exportFromLineNumber: false,
              suppressSubScriptHandling: true,
              suppressAutoLink: false,
            });
            state.content = DOMPurify.sanitize(orgHTMLDocument.toString());
            state.type = "html";
          }
          if (
            state.type == "code" &&
            contentType == "application/octet-stream"
          ) {
            state.type = "binary";
            state.content = "binary";
          }
          timers.timeout(() => { Prism.highlightAll(); }, 50);
  };
  // Files without a text body (media, notebooks, binaries, empty files and
  // per-file errors) share the code view's framed card and header.
  const FRAMED_TYPES = ["image", "media", "audio", "pdf", "IPython", "binary"];
  const FILE_ERRORS = ["file_too_big", "file_not_found", "file_not_accessible", "file_not_supported", "folder_not_supported"];
  state.fileFrame = () => {
    if (!state.filePath) return false;
    if (FRAMED_TYPES.includes(state.type)) return state.content != null;
    if (state.type === "error") return FILE_ERRORS.includes(state.content);
    return state.content == null && ["code", "text"].includes(state.type);
  };
  state.fileKind = () => {
    const name = (state.paths || [])[(state.paths || []).length - 1] || "";
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
    if (state.type === "image") return (ext === "JPG" ? "JPEG" : ext) + " image";
    const MEDIA_NAMES = { WEBM: "WebM", OGG: "Ogg", OGV: "Ogg", MOV: "QuickTime", M4V: "M4V", MKV: "Matroska" };
    if (state.type === "media") return (MEDIA_NAMES[ext] || ext) + " video";
    if (state.type === "audio") return ext + " audio";
    if (state.type === "pdf") return "PDF";
    if (state.type === "IPython") return "Jupyter notebook";
    if (state.type === "binary") return "Binary file";
    return state.languageName || (ext ? ext + " file" : "File");
  };
  state.imageSize = "";
  state.onImageLoad = (event) => {
    const img = event.target;
    if (img?.naturalWidth) state.imageSize = `${img.naturalWidth} × ${img.naturalHeight}`;
  };

  // The reviewer page closes its menus in exploreController; this is the preview's.
  listen(document, "click", e => {
    if (!state.preview) return;
    if (!e.target.closest?.(".symbols")) state.symbolsOpen = false;
    if (!e.target.closest?.(".tb-more")) state.moreOpen = false;
    if (!e.target.closest?.(".tb-toc-m")) state.tocOpen = false;
    if (e.target.isConnected && !e.target.closest?.(".goto-pop, .btn-goto, .tb-more")) state.gotoOpen = false;
  });
};
