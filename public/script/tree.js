import { h, reactive, ref, computed, watch, nextTick } from "vue";
import { useRoute } from "vue-router";

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
  props: ["file", "parent", "searchQuery", "searchResults", "page"],
  setup(props) {
    const route = useRoute();
    const host = ref(null);
    const opens = reactive(Object.create(null));
    let focusedPath = null;
    const hierarchy = computed(() => fileHierarchy(props.file));
    const selectedPath = () => "/" + (Array.isArray(route.params.path) ? route.params.path.join("/") : route.params.path || "");
    watch(() => [route.params.repoId, route.params.path], () => {
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
      link.scrollIntoView?.({ block: "nearest" });
      host.value.focus();
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
        while (node.children?.length === 1) { node = node.children[0]; name += "/" + node.name; }
        const path = parent + "/" + name;
        const folder = !!node.children;
        const open = matching.value ? opens[path] !== false : !!opens[path];
        const truncated = folder && props.page?.options?.truncatedFolders?.includes(path.slice(1));
        const count = props.page?.fileCounts?.[path.slice(1)] || 0;
        const icon = h("span", { class: folder ? "tree-icon-folder" : "tree-icon-file" });
        const label = h("span", { class: "tree-name" }, name);
        const onClick = event => {
          focus(event.currentTarget);
          if (!folder) return;
          event.preventDefault();
          opens[path] = !open;
          if (opens[path] && !node.children.length) props.page.getFiles(path.slice(1));
          nextTick(() => focus(visibleLinks().find(link => link.dataset.path === focusedPath)));
        };
        const link = h("a", {
          "data-path": path,
          href: folder ? undefined : `/r/${encodeURIComponent(route.params.repoId)}${encodePathForUrl(path)}`,
          class: { "tree-focused": focusedPath === path },
          onClick,
        }, [folder ? h("span", { class: "tree-toggle" }) : parent ? h("span", { class: "tree-spacer" }) : null, icon, label,
          truncated ? h("span", { class: "truncated-warning", title: props.page.fmt.translate("WARNINGS.folder_truncated") }, h("i", { class: "fas fa-exclamation-triangle" })) : null,
          folder && count ? h("span", { class: "tree-count" }, count) : null]);
        return h("li", { key: path, class: { file: true, folder, open, active: selectedPath() === path, truncated }, title: folder ? "" : `Size: ${humanFileSize(node.size || 0)}` }, [link, folder && open ? renderNodes(node.children, path) : null]);
      }));
    }
    return () => h("tree", { ref: host, tabindex: 0, onKeydown: keyboard },
      !props.file?.length ? "Empty repository" : matching.value?.files.size === 0 ? h("div", { class: "tree-search-empty" }, "No files found") : renderNodes(hierarchy.value));
  },
};
