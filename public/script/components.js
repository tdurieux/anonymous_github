import { loadLibrary, loadEditor } from "./lazy-assets.js";
import { h, ref, watch, onMounted, onBeforeUnmount, nextTick, defineAsyncComponent } from "vue";
import HtmlDoc from "./html-doc.js";
import PdfViewer from "./pdf-viewer.js";

const Markdown = {
  props: ["content", "terms", "options"],
  setup(props) {
    const host = ref(null);
    const render = () => {
      host.value.innerHTML = renderMD(props.content || "", window.location.pathname + "/../");
    };
    onMounted(() => { render(); watch(() => [props.content, props.terms, props.options], render, { deep: true }); });
    return () => h("markdown", { ref: host });
  },
};
const GistFile = {
  props: ["file", "terms", "options"],
  setup(props) {
    const host = ref(null);
    const highlight = () => nextTick(() => host.value?.querySelectorAll("pre code").forEach(el => window.Prism?.highlightElement(el)));
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
        host.value.innerHTML = DOMPurify.sanitize(nb.parse(json).render());
        host.value.querySelectorAll("pre code").forEach(el => window.Prism?.highlightElement(el));
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
export const components = { Markdown, GistFile, Notebook, Loc, HtmlDoc, Pdfviewer: defineAsyncComponent(async () => {
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
      latest.options?.onLoad?.(editor);
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
  beforeUnmount(el) { el._editorDisposed = true; el._editor?.destroy(); },
};
function applyEditorOptions(el, options = {}) {
  if (options.mode) el._editor.session.setMode("ace/mode/" + options.mode);
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
      links.forEach(a => a.classList.toggle("active", a === active));
    }, { rootMargin: "-20% 0px -60% 0px", threshold: 0 });
    nextTick(() => links.forEach(a => { const target = document.getElementById(a.hash.slice(1)); if (target) observer.observe(target); }));
    el._observer = observer;
  },
  beforeUnmount(el) { el._observer?.disconnect(); },
};
