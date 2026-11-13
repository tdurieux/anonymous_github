import { loadLibrary, loadEditor } from "./lazy-assets.js";
import { h, ref, watch, onMounted, onBeforeUnmount, nextTick, defineAsyncComponent } from "vue";
import HtmlDoc from "./html-doc.js";
import PdfViewer from "./pdf-viewer.js";
import { slotRedactions } from "./app.js";
import { render as quotaUsageTemplate } from "../partials/quotaUsage.htm";

const QuotaUsage = {
  props: ["quota", "fmt"],
  setup(props) {
    return { formatAmount: (value, kind) => kind === "bytes"
      ? props.fmt.humanFileSize(props.quota?.storage?.unit === "bytes" ? value * 8 : value).replace(/([a-zA-Z]+)$/, " $1") : props.fmt.number(value) };
  },
  render: quotaUsageTemplate,
};

const editorModes = new Set(__ACE_MODES__);

// ```diff fences: tint added, removed and hunk lines like the pull-request diff (Prism has no diff grammar here).
export const tintDiffBlocks = (root) => root?.querySelectorAll("pre code.language-diff, pre code.lang-diff").forEach((code) => {
  if (code.querySelector(".md-diff-line")) return;
  const lines = code.innerHTML.replace(/\n$/, "").split("\n");
  code.innerHTML = lines.map((line) => {
    const c = line.replace(/^(<[^>]+>)+/, "").charAt(0);
    const kind = line.startsWith("@@") ? "hunk" : c === "+" ? "add" : c === "-" ? "remove" : "";
    return `<span class="md-diff-line${kind ? " is-" + kind : ""}">${line || " "}</span>`;
  }).join("\n");
});
// Reviewer preview only: every code line becomes its own box, so a soft-wrapped line
// continues under a hanging indent instead of looking like a new source line. Open
// highlight spans are closed at the end of each line and reopened on the next one.
export const hangWidth = (text, skip = 0) => {
  const lead = (String(text).slice(skip).match(/^[ \t]*/)[0] || "").replace(/\t/g, "    ").length;
  return Math.min(skip + lead + 4, 24);
};
export const hangCodeLines = (root) => {
  if (!root?.closest?.(".reviewer-preview")) return;
  root.querySelectorAll("pre code").forEach((code) => {
    const diffLines = code.querySelectorAll(".md-diff-line");
    if (diffLines.length) {
      diffLines.forEach((line) => { if (!line.classList.contains("is-hunk")) line.style.setProperty("--hang", hangWidth(line.textContent, 1) + "ch"); });
      return;
    }
    if (code.querySelector(".code-line")) return;
    const open = [];
    code.innerHTML = code.innerHTML.replace(/\n$/, "").split("\n").map((line) => {
      const head = open.join("");
      line.replace(/<\/?span\b[^>]*>/g, (tag) => { if (tag.startsWith("</")) open.pop(); else open.push(tag); return tag; });
      const text = line.replace(/<[^>]+>/g, "");
      return `<span class="code-line" style="--hang:${hangWidth(text)}ch">${head}${line || " "}${"</span>".repeat(open.length)}</span>`;
    }).join("\n");
  });
};
const Markdown = {
  props: ["content", "terms", "options"],
  setup(props) {
    const host = ref(null);
    const render = () => {
      host.value.innerHTML = renderMD(props.content || "", window.location.pathname + "/../");
      tintDiffBlocks(host.value);
      hangCodeLines(host.value);
    };
    onMounted(() => { render(); watch(() => [props.content, props.terms, props.options], render, { deep: true }); });
    return () => h("markdown", { ref: host });
  },
};
const GistFile = {
  props: ["file", "terms", "options"],
  setup(props) {
    const host = ref(null);
    const highlight = () => nextTick(() => { host.value?.querySelectorAll("pre code").forEach(el => window.Prism?.highlightElement(el)); tintDiffBlocks(host.value); hangCodeLines(host.value); });
    onMounted(highlight);
    watch(() => [props.file?.content, props.terms, props.options], highlight, { deep: true });
    return () => {
      const file = props.file || {};
      const extension = (file.filename || "").split(".").pop().toLowerCase();
      if (["md", "markdown"].includes(extension) || file.language === "Markdown") {
        return h("gist-file", { ref: host }, h(Markdown, { content: file.content, terms: props.terms, options: props.options }));
      }
      const aliases = { js: "javascript", jsx: "javascript", ts: "javascript", typescript: "javascript", py: "python", html: "markup", xml: "markup", svg: "markup", sh: "bash" };
      const language = (file.language || extension || "none").toLowerCase();
      return h("gist-file", { ref: host }, h("pre", { class: "line-numbers" }, h("code", { class: "language-" + (aliases[language] || language), key: file.content }, file.content || "")));
    };
  },
};
// Notebook input cells keep their source layout and scroll sideways. A cell whose code is wider than
// its box gets a right-edge fade (gone once scrolled to the end) so hidden code is discoverable.
const markScrollableCode = (root) => root?.querySelectorAll(".nb-input pre").forEach((pre) => {
  if (pre.parentElement?.classList.contains("nb-code-scroll")) return;
  const wrap = document.createElement("div");
  wrap.className = "nb-code-scroll";
  pre.replaceWith(wrap);
  wrap.appendChild(pre);
  const update = () => {
    const overflow = pre.scrollWidth - pre.clientWidth > 1;
    wrap.classList.toggle("is-overflowing", overflow);
    wrap.classList.toggle("is-at-end", overflow && pre.scrollLeft + pre.clientWidth >= pre.scrollWidth - 2);
    if (!overflow) return;
    // Touch browsers hide scrollbars, so the cell draws its own thin position indicator.
    const track = pre.clientWidth - 16;
    const thumb = Math.max(24, track * pre.clientWidth / pre.scrollWidth);
    wrap.style.setProperty("--thumb-w", thumb + "px");
    wrap.style.setProperty("--thumb-x", (track - thumb) * pre.scrollLeft / (pre.scrollWidth - pre.clientWidth) + "px");
  };
  pre.addEventListener("scroll", update, { passive: true });
  window.ResizeObserver ? new ResizeObserver(update).observe(pre) : update();
  update();
});
const Notebook = {
  props: ["file", "content"],
  setup(props) {
    const host = ref(null);
    let generation = 0;
    let request;
    const render = async () => {
      const current = ++generation;
      request?.abort();
      request = new AbortController();
      try {
        const json = props.content ? JSON.parse(props.content) : await fetch(props.file?.download_url || props.file, { signal: request.signal }).then(r => { if (!r.ok) throw Error("Notebook request failed"); return r.json(); });
        await loadLibrary("notebook");
        if (current !== generation) return;
        // Outputs and Markdown cells show XXXX-n as the same numbered slot as the rest of the viewer.
        host.value.innerHTML = slotRedactions(DOMPurify.sanitize(nb.parse(json).render()));
        host.value.querySelectorAll("pre code").forEach(el => window.Prism?.highlightElement(el));
        markScrollableCode(host.value);
      } catch (error) { if (current === generation && error.name !== "AbortError") host.value.textContent = "Unable to render the notebook."; }
    };
    onMounted(() => { render(); watch(() => [props.file, props.content], render); });
    onBeforeUnmount(() => { generation++; request?.abort(); });
    return () => h("notebook", { ref: host });
  },
};
const Loc = {
  props: ["stats"],
  setup(props) {
    return () => {
      const rows = Object.entries(props.stats || {}).filter(([, stat]) => stat.code);
      const total = rows.reduce((sum, [, stat]) => sum + stat.code, 0);
      return h("loc", rows.map(([language, stat]) => h("div", { class: "lang", title: `${language}: ${stat.code.toLocaleString()} lines`, style: { width: stat.code * 100 / total + "%", background: langColors[language] } })));
    };
  },
};
export const components = { Markdown, GistFile, Notebook, Loc, HtmlDoc, QuotaUsage, Pdfviewer: defineAsyncComponent(async () => {
  await loadLibrary("pdf");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/script/external/pdf.worker.js";
  return PdfViewer;
}) };

export const codeEditor = {
  async mounted(el, { value }) {
    el._editorValue = value;
    try {
      await loadEditor();
      if (el._editorDisposed) return;
      const latest = el._editorValue;
      const editor = ace.edit(el);
      el._editor = editor;
      editor.setValue(String(latest.content ?? ""), -1);
      applyEditorOptions(el, latest.options);
      el._editorCleanup = latest.options?.onLoad?.(editor);
    } catch (error) {
      if (!el._editorDisposed) el.textContent = error.message;
    }
  },
  updated(el, { value }) {
    el._editorValue = value;
    if (!el._editor) return;
    if (el._editor.getValue() !== String(value.content ?? "")) el._editor.setValue(String(value.content ?? ""), -1);
    applyEditorOptions(el, value.options);
  },
  beforeUnmount(el) { el._editorDisposed = true; el._editorCleanup?.(); el._editor?.destroy(); },
};
function applyEditorOptions(el, options = {}) {
  const mode = editorModes.has(options.mode) ? options.mode : "text";
  el._editor.session.setMode("ace/mode/" + mode);
  if (options.theme) el._editor.setTheme("ace/theme/" + options.theme);
  el._editor.setReadOnly(options.readOnly !== false);
}
export const paperScrollspy = {
  mounted(el) {
    if (!window.IntersectionObserver) return;
    const links = [...el.querySelectorAll('a[href^="#"]')];
    const visible = new Set();
    const observer = new IntersectionObserver(entries => {
      entries.forEach(e => e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id));
      const active = links.find(a => visible.has(a.hash.slice(1)));
      if (active) links.forEach(a => a.classList.toggle("active", a === active));
    }, { rootMargin: "-20% 0px -60% 0px", threshold: 0 });
    nextTick(() => {
      links.forEach(a => { const target = document.getElementById(a.hash.slice(1)); if (target) observer.observe(target); });
      if (links[0] && !links.some(a => a.classList.contains("active"))) links[0].classList.add("active");
    });
    el._observer = observer;
  },
  beforeUnmount(el) { el._observer?.disconnect(); },
};
