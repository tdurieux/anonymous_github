import { computed } from "vue";

// Local state formerly initialized by templates; list aliases are computed.
export function initializeTemplate(name, state) {
  if (name === "partials/explorer.htm") {
    state.sidebarCollapsed = window.matchMedia?.("(max-width: 767px)").matches || false;
    state.sidebarHidden = false;
    state.dirExpanded = false;
    state.moreOpen = false;
    state.tocOpen = false;
    state.gotoOpen = false;
    state.gotoValue = "";
    state.gotoError = "";
    state.mdFindOpen = false;
    state.mdFindQuery = "";
    state.mdFindTotal = 0;
    state.mdFindIndex = 0;
    state.mdFindCase = false;
    state.accountOpen = false;
    state.helpOpen = false;
    state.sidebarWidth = Math.min(520, Math.max(220, Number(localStorage.getItem("sidebarWidth")) || (window.innerWidth >= 1280 ? 320 : 280)));
    // Shared with the app bar so the brand column lines up with the file tree.
    document.documentElement.style.setProperty("--sidebar-w", state.sidebarWidth + "px");
    state.startSidebarResize = (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = state.sidebarWidth;
      const move = (e) => {
        state.sidebarWidth = Math.min(520, Math.max(220, startWidth + e.clientX - startX));
        document.documentElement.style.setProperty("--sidebar-w", state.sidebarWidth + "px");
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.classList.remove("is-resizing");
        localStorage.setItem("sidebarWidth", String(state.sidebarWidth));
      };
      document.body.classList.add("is-resizing");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
  }
  if (name === "partials/anonymize.htm") {
    state.prTabState = { active: state.options.diff ? "diff" : "comments" };
    state.watchGroup(["options.diff", "options.comments"], () => {
      if (!state.options[state.prTabState.active]) state.prTabState.active = state.options.diff ? "diff" : state.options.comments ? "comments" : null;
    });
  }
  if (name === "partials/gist.htm") state.tabState = { active: state.details?.files ? "files" : "comments" };
  if (["partials/conferences.htm", "partials/conference.htm"].includes(name)) {
    state.statusLabels = { ready: "Ready", expired: "Expired", removed: "Removed" };
  }
  const lists = {
    "partials/dashboard.htm": ["filteredItems", () => state.items, "itemFilter"],
    "partials/conferences.htm": ["filteredConferences", () => state.conferences, "conferenceFilter"],
    "partials/conference.htm": ["filteredRepositories", () => state.conference?.repositories, "repoFiler"],
    "partials/admin/repositories.htm": ["filteredRepositories", () => state.repositories, "repoFiler"],
    "partials/admin/user.htm": ["filteredRepositories", () => state.repositories, "repoFiler"],
    "partials/admin/users.htm": ["filteredUsers", () => state.users, "userFiler"],
    "partials/admin/conferences.htm": ["filteredConferences", () => state.conferences],
  };
  const list = lists[name];
  if (list) {
    const value = computed(() => state.fmt.orderBy(state.fmt.filter(list[1](), state[list[2]]), state.orderBy));
    Object.defineProperty(state, list[0], { configurable: true, get: () => value.value });
  }
}
