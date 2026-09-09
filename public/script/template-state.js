import { computed } from "vue";

// Local state formerly initialized by templates; list aliases are computed.
export function initializeTemplate(name, state) {
  if (name === "partials/explorer.htm") {
    state.sidebarCollapsed = window.matchMedia?.("(max-width: 767px)").matches || false;
  }
  if (name === "partials/anonymize.htm") state.prTabState = { active: state.options.diff ? "diff" : "comments" };
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
