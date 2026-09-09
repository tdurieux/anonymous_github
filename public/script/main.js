import { createApp, h, watch, provide, inject, onBeforeUnmount } from "vue";
import { createRouter, createWebHistory, RouterView } from "vue-router";
import { pageRoutes } from "./routes.js";
import { templates } from "./templates.js";
import { initializeTemplate } from "./template-state.js";
import { createPageState, createTimers } from "./state.js";
import { createHttp, promises } from "./http.js";
import { mainController } from "./app.js";
import { createQuotaService } from "./quota.js";
import * as formatters from "./formatters.js";
import translations from "../i18n/locale-en.json";
import { components, codeEditor, paperScrollspy } from "./components.js";
import Tree from "./tree.js";
import { fieldDirective, formDirective, submitForm } from "./forms.js";

const sessionKey = Symbol("session");
export const serverPaths = /^\/(w|api|github)(\/|$)/;
function translate(key, params = {}) {
  const message = key?.split(".").reduce((value, part) => value?.[part], translations);
  return String(message ?? key ?? "").replace(/{{\s*([^}]+?)\s*}}/g, (_, name) => params[name] ?? "");
}
const fmt = { ...formatters, translate };
export function safeUrl(value) {
  if (value == null || value === "") return value;
  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:", "mailto:", "tel:", "blob:"].includes(url.protocol) ? value : undefined;
  } catch { return undefined; }
}

export function mountApplication(target = "#app", options = {}) {
  const events = new Map();
  const http = createHttp(options.fetch);
  let root;
  let router;
  function services() {
    const timers = createTimers();
    const location = {
      url(value) { if (value === undefined) return router.currentRoute.value.fullPath; router.push(value); return location; },
      path() { return router.currentRoute.value.path; },
      search() { return router.currentRoute.value.query; },
    };
    const params = new Proxy({}, { get(_, key) {
      const value = router.currentRoute.value.params[key];
      return Array.isArray(value) ? value.join("/") : value;
    } });
    return { http, ...timers, location, params, window, promises, html: { trustAsHtml: value => value }, translate: (key, params) => Promise.resolve(translate(key, params)), quotaService: createQuotaService(http) };
  }
  function pageComponent(definition) {
    return {
      name: definition.template,
      setup() {
        const state = createPageState(inject(sessionKey), events);
        definition.setup(state, services());
        initializeTemplate(definition.template, state);
        const cache = [];
        return () => templates[definition.template](state, cache);
      },
    };
  }
  router = createRouter({
    history: options.history || createWebHistory(),
    routes: pageRoutes.map(definition => definition.redirect ? definition : ({
      path: definition.path,
      component: pageComponent(definition),
      meta: { title: definition.title, preserveExplorer: definition.preserveExplorer },
    })),
  });
  const app = createApp({
    setup() {
      root = createPageState(null, events);
      root.fmt = fmt;
      root.window = window;
      root.Math = Math;
      root.sanitize = value => DOMPurify.sanitize(value ?? "");
      root.submitForm = submitForm;
      root.safeUrl = safeUrl;
      const context = services();
      mainController(root, context.http, context.location, context.timeout);
      provide(sessionKey, root);
      watch(() => root.title, title => { document.title = title || "Anonymous GitHub"; });
      const headerCache = [];
      const navigate = event => {
        const anchor = event.target.closest?.("a[href]");
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self") || anchor.dataset.toggle) return;
        const href = anchor.getAttribute("href");
        if (href.startsWith("#")) return;
        const url = new URL(anchor.href, window.location.href);
        if (url.origin !== window.location.origin || serverPaths.test(url.pathname)) return;
        event.preventDefault();
        router.push(url.pathname + url.search + url.hash);
        $("#navbarSupportedContent.show").collapse("hide");
      };
      document.addEventListener("click", navigate);
      onBeforeUnmount(() => document.removeEventListener("click", navigate));
      return () => [
        h("header", { class: "app-header" }, templates["partials/header.htm"](root, headerCache)),
        h("main", { class: "app-view align-items-stretch w-100" }, h(RouterView, null, {
          default: ({ Component, route }) => Component ? h(Component, { key: route.meta.preserveExplorer ? route.matched[0]?.path : route.path }) : null,
        })),
        h("div", { class: "position-fixed p-3", style: { zIndex: 999999999, right: 0, bottom: 0 } }, root.toasts.map((toast, i) => h("div", { class: "toast show", role: "alert", "aria-live": "assertive", "aria-atomic": "true", key: i }, [
          h("div", { class: "toast-header" }, [h("strong", { class: "mr-auto" }, toast.title), h("button", { type: "button", class: "ml-2 mb-1 close", "aria-label": "Close", onClick: () => root.removeToast(toast) }, "×")]),
          h("div", { class: "toast-body" }, toast.body),
        ]))),
      ];
    },
  });
  for (const [name, component] of Object.entries(components)) app.component(name, component);
  app.component("Tree", Tree);
  app.component("PartialView", {
    props: ["name", "state"],
    setup(props) { const cache = []; return () => templates[props.name](props.state, cache); },
  });
  app.directive("field", fieldDirective);
  app.directive("form", formDirective);
  app.directive("code-editor", codeEditor);
  app.directive("paper-scrollspy", paperScrollspy);
  app.use(router);
  router.beforeEach(() => { root?.emit("routeLeave"); });
  router.afterEach(to => {
    if (!root) return;
    root.title = to.meta.title;
    root.emit("routeChange", { title: to.meta.title });
    root.emit("routeUpdate", { title: to.meta.title });
    const view = document.querySelector(".app-view");
    if (!to.meta.preserveExplorer && view) view.scrollTop = 0;
  });
  app.mount(target);
  return { app, router, state: root };
}

ace.config.set("basePath", "/script/external/ace/");
pdfjsLib.GlobalWorkerOptions.workerSrc = "/script/external/pdf.worker.js";
if (document.querySelector("#app")) window.anonymousApp = mountApplication();
