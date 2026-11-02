import { renderMarkdown } from "../../src/markdown";
import { stlPaths } from "../../src/markdown-diagrams";
// htmlparser2 uses this ES2022 builtin; retain the viewer's older-browser support.
if (!Object.hasOwn) Object.defineProperty(Object, "hasOwn", {
  value: (object, key) => Object.prototype.hasOwnProperty.call(object, key),
  configurable: true, writable: true,
});
window.MarkdownRenderer = { render: renderMarkdown };

// Delegation also covers documents inserted by Vue after this lazy bundle loads.
document.addEventListener("click", event => {
  const button = event.target.closest?.("button[data-diagram-action]");
  const figure = button?.closest("figure.markdown-diagram");
  if (!figure) return;
  const group = figure.querySelector("svg g");
  const action = button.dataset.diagramAction;
  let zoom = Number(figure.dataset.zoom || 1);
  if (action === "rotate") {
    try {
      const vertices = JSON.parse(figure.dataset.vertices);
      if (!Array.isArray(vertices) || vertices.length > 60000 || vertices.length % 3 || vertices.some(v => !Array.isArray(v) || v.length !== 3 || v.some(n => typeof n !== "number" || !Number.isFinite(n)))) return;
      const angle = Number(figure.dataset.angle || 0.6) + 0.3;
      figure.dataset.angle = angle;
      group.innerHTML = stlPaths(vertices, angle);
    } catch { return; }
  } else {
    if (action === "reset" && figure.dataset.vertices) {
      // Reuse the validated rotation path, then restore the initial view angle.
      figure.dataset.angle = 0.3;
      figure.querySelector('[data-diagram-action="rotate"]')?.click();
    }
    zoom = action === "reset" ? 1 : Math.max(0.25, Math.min(8, zoom * (action === "in" ? 1.25 : 0.8)));
    figure.dataset.zoom = zoom;
    group.setAttribute("transform", `translate(320 160) scale(${zoom}) translate(-320 -160)`);
  }
});

let pending = false;
async function enhance() {
  if (pending) return;
  const diagrams = [...document.querySelectorAll("pre.mermaid:not([data-processed])")];
  if (!diagrams.length) return;
  pending = true;
  try {
    if (typeof window.mermaid?.initialize !== "function" || typeof window.mermaid?.run !== "function") {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/script/mermaid.min.js";
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
    // A raw HTML id can create a named window property. Do not trust a global
    // initialization flag supplied by document content.
    window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
    window.mermaidInitialized = true;
    for (const element of diagrams) {
      const source = element.textContent;
      try { await window.mermaid.run({ nodes: [element] }); }
      catch { element.textContent = source; element.dataset.processed = "true"; }
    }
  } finally {
    pending = false;
    if ([...document.querySelectorAll("pre.mermaid:not([data-processed])")].some(node => !diagrams.includes(node))) enhance().catch(() => {});
  }
}
const observer = new MutationObserver(() => { enhance().catch(() => {}); });
observer.observe(document.documentElement, { childList: true, subtree: true });
enhance().catch(() => {});
