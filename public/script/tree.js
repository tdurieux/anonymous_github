import { h, reactive, ref, computed, watch, nextTick } from "vue";
import { useRoute } from "vue-router";

// Redacted segments (XXXX-N) render as a slot holding the term number; the rest stays readable.
function redactedNodes(text) {
  const out = []; let last = 0; const re = /\bXXXX-(\d+)\b/g; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h("span", { class: "redact-slot", role: "img", "aria-label": "Redacted term " + m[1] }, [h("i", null, m[1])]));
    last = m.index + m[0].length;
  }
  if (!out.length) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Full names with a break opportunity (<wbr>) after ".", "-" and "_", so long
// names wrap at a separator rather than mid-word. Redaction slots stay whole.
function breakableNodes(text) {
  const parts = redactedNodes(text);
  const out = [];
  for (const part of Array.isArray(parts) ? parts : [parts]) {
    if (typeof part !== "string") { out.push(part); continue; }
    const pieces = part.split(/(?<=[._-])/);
    pieces.forEach((piece, i) => { out.push(piece); if (i < pieces.length - 1) out.push(h("wbr")); });
  }
  return out;
}

// File sizes from the API are bytes; the global humanFileSize expects bits.
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let u = 0;
  while (value >= 1024 && u < units.length - 1) { value /= 1024; u++; }
  return `${value.toFixed(1)} ${units[u]}`;
}

export function fileHierarchy(files) {
  const root = { children: [] };
  const directories = new Map([["", root]]);
  function directory(path) {
    if (directories.has(path)) return directories.get(path);
    const index = path.lastIndexOf("/");
    const parent = directory(index < 0 ? "" : path.slice(0, index));
    const node = { name: path.slice(index + 1), children: [] };
    directories.set(path, node);
    parent.children.push(node);
    return node;
  }
  for (const file of files || []) {
    const path = file.path ? `${file.path}/${file.name}` : file.name;
    if (file.size == null) directory(path);
    else directory(file.path || "").children.push({ ...file });
  }
  return root.children;
}

export default {
  name: "FileTree",
  props: ["file", "parent", "searchQuery", "searchResults", "page", "selectedPath"],
  emits: ["select"],
  setup(props, { emit }) {
    const route = useRoute();
    const host = ref(null);
    const opens = reactive(Object.create(null));
    let focusedPath = null;
    const hierarchy = computed(() => fileHierarchy(props.file));
    const selectedPath = () => props.selectedPath ?? "/" + (Array.isArray(route.params.path) ? route.params.path.join("/") : route.params.path || "");
    watch(() => [route.params.repoId, route.params.path, props.selectedPath], () => {
      let path = "";
      selectedPath().split("/").filter(Boolean).forEach(part => { path += "/" + part; opens[path] = true; });
    }, { immediate: true });
    const matching = computed(() => {
      if (!props.searchQuery || !props.searchResults) return null;
      const files = new Set(), folders = new Set();
      props.searchResults.forEach(file => {
        files.add(file.path ? `${file.path}/${file.name}` : file.name);
        let path = "";
        (file.path || "").split("/").filter(Boolean).forEach(part => { path = path ? path + "/" + part : part; folders.add(path); });
      });
      return { files, folders };
    });
    const visibleLinks = () => [...host.value.querySelectorAll("li > a")];
    const focus = link => {
      host.value.querySelector(".tree-focused")?.classList.remove("tree-focused");
      if (!link) return;
      focusedPath = link.dataset.path;
      link.classList.add("tree-focused");
      if (props.selectedPath === undefined) {
        link.scrollIntoView?.({ block: "nearest" });
        host.value.focus();
        return;
      }
      // Embedded (the anonymize preview): scroll only the tree, never the page.
      const scroller = host.value.scrollHeight > host.value.clientHeight ? host.value : host.value.closest(".leftCol-body");
      if (scroller) {
        const row = link.getBoundingClientRect(), bounds = scroller.getBoundingClientRect();
        if (row.top < bounds.top) scroller.scrollTop -= bounds.top - row.top;
        else if (row.bottom > bounds.bottom) scroller.scrollTop += row.bottom - bounds.bottom;
      }
      host.value.focus({ preventScroll: true });
    };
    function keyboard(event) {
      const links = visibleLinks();
      const current = host.value.querySelector(".tree-focused") || links[0];
      const index = links.indexOf(current);
      if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Enter"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "ArrowDown") focus(links[(index + 1) % links.length]);
      if (event.key === "ArrowUp") focus(links[(index - 1 + links.length) % links.length]);
      if (!current) return;
      const li = current.closest("li");
      if (event.key === "ArrowRight" && li.classList.contains("folder")) {
        if (!li.classList.contains("open")) current.click();
        else focus(li.querySelector(":scope > ul > li > a"));
      }
      if (event.key === "ArrowLeft") {
        if (li.classList.contains("folder") && li.classList.contains("open")) current.click();
        else focus(li.parentElement.closest("li.folder")?.querySelector(":scope > a"));
      }
      if (event.key === "Enter") current.click();
    }
    function renderNodes(nodes, parent = "") {
      const sorted = [...nodes].sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name));
      return h("ul", sorted.flatMap(original => {
        let node = original, name = node.name;
        const originalPath = (parent + "/" + name).slice(1);
        if (matching.value && !matching.value.files.has(originalPath) && !matching.value.folders.has(originalPath)) return [];
        // GitHub-style "a/b" rows join folder chains only, and only once the
        // folder's listing is loaded: a folder that so far holds just the open
        // file stays a real, expandable folder in its sorted place.
        while (node.children?.length === 1 && node.children[0].children && props.page?.loadedFolders?.[(parent + "/" + name).slice(1)]) { node = node.children[0]; name += "/" + node.name; }
        const path = parent + "/" + name;
        const folder = !!node.children;
        const open = matching.value ? opens[path] !== false : !!opens[path];
        const truncated = folder && props.page?.options?.truncatedFolders?.includes(path.slice(1));
        const icon = h("span", { class: folder ? "tree-icon-folder" : "far fa-file tree-icon-file", "aria-hidden": "true" },
          folder ? h("svg", { viewBox: "0 0 14 12", focusable: "false" }, h("path", { d: "M1.5 10.5v-9h4l1.5 2h5.5v7z" })) : null);
        // Names show in full: long ones wrap onto a second line, preferably after
        // ".", "-" or "_" (a <wbr> after each), with CSS overflow-wrap as the fallback.
        // Only pathological names (over 80 characters) still truncate in the middle so
        // the end and extension stay visible; a redaction token is never split.
        let splitName = false, head = name, tail = "", middle = "";
        if (name.length > 80) {
          let tailAt = name.length - 12;
          for (let i = name.length - 18; i <= name.length - 6; i++) if (i > 0 && "-_. ".includes(name[i])) { tailAt = i; break; }
          splitName = !/XXXX-\d+/.test(name.slice(Math.max(0, tailAt - 12)));
          head = name.slice(0, tailAt).trimEnd(); tail = name.slice(tailAt).trimStart();
          if (splitName) {
            const budget = Math.max(8, 30 - tail.length - 1);
            if (head.length > budget && !/XXXX-\d+/.test(head)) {
              let at = -1;
              for (let i = Math.min(budget, head.length); i >= 4; i--) if (".-_".includes(head[i])) { at = i; break; }
              const full = name.slice(0, name.length - tail.length);
              head = (at > 0 ? head.slice(0, at) : head.slice(0, budget)).trimEnd();
              middle = full.slice(head.length);
            }
          }
        }
        const label = h("span", { class: { "tree-name": true, "tree-name-split": splitName, "tree-name-wrap": !splitName }, title: name.replace(/\bXXXX-(\d+)\b/g, "[redacted term $1]") },
          splitName ? [h("span", { class: { "tree-name-head": true, "is-cut": !!middle } }, redactedNodes(head)), middle ? h("span", { class: "tree-name-middle" }, middle) : null, h("span", { class: "tree-name-tail" }, tail)] : breakableNodes(name));
        const onClick = event => {
          focus(event.currentTarget);
          if (!folder) {
            if (props.selectedPath !== undefined) { event.preventDefault(); emit("select", path); }
            return;
          }
          event.preventDefault();
          opens[path] = !open;
          if (opens[path] && !node.children.length) props.page.getFiles(path.slice(1));
          nextTick(() => focus(visibleLinks().find(link => link.dataset.path === focusedPath)));
        };
        const link = h("a", {
          "data-path": path,
          // Embedded only: the reviewer page's markup stays as it was.
          "aria-expanded": props.selectedPath !== undefined && folder ? String(open) : undefined,
          "aria-current": props.selectedPath !== undefined && !folder && selectedPath() === path ? "page" : undefined,
          href: folder ? undefined : `/r/${encodeURIComponent(route.params.repoId)}${encodePathForUrl(path)}`,
          class: { "tree-focused": focusedPath === path },
          onClick,
        }, [folder ? h("span", { class: "tree-toggle" }) : h("span", { class: "tree-spacer" }), icon, label,
          truncated ? h("span", { class: "truncated-warning", title: props.page.fmt.translate("WARNINGS.folder_truncated") }, h("i", { class: "fas fa-exclamation-triangle" })) : null,
        ]);
        return h("li", { key: path, class: { file: true, folder, open, active: selectedPath() === path, truncated }, title: folder ? "" : `Size: ${formatBytes(node.size || 0)}` }, [link, folder && open ? (node.children.length || !props.page?.loadedFolders?.[path.slice(1)] ? renderNodes(node.children, path) : h("ul", h("li", { class: "tree-empty" }, "Empty folder"))) : null]);
      }));
    }
    return () => h("tree", { ref: host, tabindex: 0, onKeydown: keyboard },
      !props.file?.length ? "Empty repository" : matching.value?.files.size === 0 ? h("div", { class: "tree-search-empty" }, "No files found") : renderNodes(hierarchy.value));
  },
};
