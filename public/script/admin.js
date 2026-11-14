import { reactive, onScopeDispose } from "vue";
import { createTimers, createListeners } from "./state.js";
import { duration, statusMsg } from "./formatters.js";

// One status filter model for every admin list (and the conference page):
// a single-select segmented control. One rule everywhere: "All N" is every
// record in the list, removed ones included, and selecting it shows exactly
// those N rows. The status chips partition All, so their counts add up to it.
// `flags()` returns the boolean status map the list already filters on.
export const statusGroup = (status) =>
  ["preparing", "download", "downloading", "downloaded", "queue", "anonymizing"].includes(status) ? "preparing"
  : status === "expiring" ? "expired"
  : status === "removing" ? "removed"
  : status;
export function installStatusSegments(state, { flags, keys, count, onChange = () => {} }) {
  state.segView = () => {
    const f = flags() || {};
    if (keys.every((k) => !!f[k])) return "all";
    const on = keys.filter((k) => !!f[k]);
    return on.length === 1 ? on[0] : "custom";
  };
  state.setSegView = (view) => {
    const f = flags();
    if (!f) return;
    for (const k of keys) f[k] = view === "all" ? true : k === view;
    onChange();
  };
  state.segCount = (view) => view === "all" ? keys.reduce((n, k) => n + count(k), 0) : count(view);
  // Saved preferences from the old "All hides removed" model come back as a
  // mixed selection; fold them into All so one chip is always selected.
  if (flags() && state.segView() === "custom") for (const k of keys) flags()[k] = true;
}

// Page setup functions run inside Vue effect scopes.
export const repositoriesAdminController = function (state, http, location) {
      const timers = createTimers();
      const listen = createListeners();
      watchMetaLines(timers, listen);
      state.Math = Math;
      state.watch("user.status", () => {
        if (state.user == null) {
          location.url("/");
        }
      });
      if (state.user == null) {
        location.url("/");
      }

      state.repositories = [];
      state.total = -1;
      state.totalPage = 0;
      state.statusCounts = [];
      state.totalSize = 0;
      state.selected = {};
      state.allSelected = false;

      // Slash-to-focus the search input
      const searchKeyHandler = (e) => {
        if (e.key === "/" && !["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName)) {
          e.preventDefault();
          const el = document.querySelector('.admin-filter-toolbar input[type="search"]');
          el && el.focus();
        }
      };
      listen(document, "keydown", searchKeyHandler);
      state.on("dispose", () => document.removeEventListener("keydown", searchKeyHandler));

      state.clearFilter = (key) => {
        if (key === "dateRange") { state.query.dateFrom = ""; state.query.dateTo = ""; }
        else state.query[key] = "";
        state.query.page = 1;
      };
      state.chips = [];
      const recomputeChips = () => {
        const out = [];
        if (state.query.owner) out.push({ key: "owner", label: "Owner", value: state.query.owner });
        if (state.query.conference) out.push({ key: "conference", label: "Conference", value: state.query.conference });
        state.chips = out;
      };

      state.showStatusMessage = (repo) => {
        const msg = repo.statusMessage || "(no message)";
        window.prompt(`Status message for ${repo.repoId} (${repo.status}):`, msg);
      };

      state.fetchGithubInfo = (repo) => {
        const w = window.open("", "_blank");
        if (w) w.document.write("<pre>Loading GitHub info for " + repo.repoId + "...</pre>");
        http.get("/api/admin/repos/" + repo.repoId + "/github").then(
          (res) => {
            if (w) {
              w.document.open();
              w.document.write(
                "<pre style=\"font:13px monospace;padding:16px;white-space:pre-wrap\">" +
                  JSON.stringify(res.data, null, 2).replace(/[<>]/g, (c) => c === "<" ? "&lt;" : "&gt;") +
                  "</pre>"
              );
              w.document.close();
            }
          },
          (err) => {
            const msg = err && err.data ? JSON.stringify(err.data, null, 2) : String(err);
            if (w) w.document.body.innerHTML = "<pre style=\"color:#B42318;padding:16px\">" + msg + "</pre>";
          }
        );
      };

      state.statusCountFor = (s) => {
        const row = (state.statusCounts || []).find((c) => c._id === s);
        return row ? row.count : 0;
      };

      state.statusStorageFor = (s) => {
        const row = (state.statusCounts || []).find((c) => c._id === s);
        return row ? row.storage : 0;
      };

      state.isErrorsOnly = () =>
        state.query &&
        state.query.error && !state.query.ready && !state.query.preparing &&
        !state.query.expired && !state.query.removed;

      state.toggleErrorsOnly = () => {
        if (state.isErrorsOnly()) {
          Object.assign(state.query, { ready: false, preparing: true, expired: false, removed: false, error: true });
        } else {
          Object.assign(state.query, { ready: false, preparing: false, expired: false, removed: false, error: true });
        }
        state.query.page = 1;
      };

      state.toggleSortDirection = () => {
        state.query.direction = state.query.direction === "asc" ? "desc" : "asc";
      };
      state.sortBy = (field) => {
        if (state.query.sort === field) {
          state.query.direction = state.query.direction === "asc" ? "desc" : "asc";
        } else {
          state.query.sort = field;
          state.query.direction = "desc";
        }
        state.query.page = 1;
      };
      state.sortIcon = (field) =>
        state.query.sort === field
          ? (state.query.direction === "asc" ? "fa-arrow-up" : "fa-arrow-down")
          : "";

      const reposAdminPrefsKey = "admin.repos.filterPrefs";
      const reposAdminDefaults = {
        page: 1,
        limit: 25,
        sort: "lastView",
        direction: "desc",
        search: "",
        owner: "",
        conference: "",
        dateFrom: "",
        dateTo: "",
        ready: true,
        expired: true,
        removed: true,
        error: true,
        preparing: true,
      };
      const savedReposAdminPrefs = loadFilterPrefs(reposAdminPrefsKey) || {};
      state.query = Object.assign({}, reposAdminDefaults, savedReposAdminPrefs, {
        page: 1,
        search: "",
      });

      // pre-fill filters from URL ?owner= / ?conference= / ?search=
      const urlParams = location.search();
      if (urlParams.owner) state.query.owner = urlParams.owner;
      if (urlParams.conference) state.query.conference = urlParams.conference;
      if (urlParams.search) state.query.search = urlParams.search;

      // -------- presets --------
      const presetsKey = "admin.repos.presets";
      state.presets = JSON.parse(localStorage.getItem(presetsKey) || "[]");
      state.savePreset = () => {
        const name = window.prompt("Preset name:");
        if (!name) return;
        const snapshot = Object.assign({}, state.query);
        delete snapshot.page;
        state.presets = (state.presets || []).filter((p) => p.name !== name);
        state.presets.push({ name, query: snapshot });
        localStorage.setItem(presetsKey, JSON.stringify(state.presets));
      };
      state.applyPreset = (p) => {
        Object.assign(state.query, p.query, { page: 1 });
      };
      state.deletePreset = (p) => {
        state.presets = (state.presets || []).filter((x) => x.name !== p.name);
        localStorage.setItem(presetsKey, JSON.stringify(state.presets));
      };

      // -------- selection / bulk --------
      state.selectAllOnPage = () => {
        state.allSelected = !state.allSelected;
        state.repositories.forEach((r) => {
          state.selected[r.repoId] = state.allSelected;
        });
      };
      state.selectedCount = () =>
        Object.values(state.selected || {}).filter(Boolean).length;
      state.selectedRepos = () =>
        state.repositories.filter((r) => state.selected[r.repoId]);

      state.bulkRefresh = () => {
        const repos = state.selectedRepos();
        if (!repos.length) return;
        if (!confirm(`Force refresh ${repos.length} repositories?`)) return;
        repos.forEach((r) => state.updateRepository(r));
      };
      state.bulkRemoveCache = () => {
        const repos = state.selectedRepos();
        if (!repos.length) return;
        if (!confirm(`Purge cache for ${repos.length} repositories?`)) return;
        repos.forEach((r) => state.removeCache(r));
      };
      state.clearSelection = () => {
        state.selected = {};
        state.allSelected = false;
      };

      // -------- export --------
      state.exportCsv = () => {
        const params = new URLSearchParams(
          Object.entries(state.query).filter(([, v]) => v !== "" && v !== false && v != null)
        );
        params.set("format", "csv");
        params.set("limit", "10000");
        window.open("/api/admin/repos?" + params.toString(), "_blank");
      };

      state.removeCache = (repo) => {
        if (!confirm("Remove cached files for " + repo.repoId + "?")) return;
        http.delete("/api/admin/repos/" + repo.repoId).then(
          () => getRepositories(),
          (err) => console.error(err)
        );
      };

      state.removeRepository = (repo) => {
        if (!confirm("Remove repository " + repo.repoId + "?")) return;
        http.delete("/api/repo/" + repo.repoId + "/").then(
          () => getRepositories(),
          (err) => console.error(err)
        );
      };

      state.updateRepository = (repo) => {
        const toast = reactive({
          title: `Refreshing ${repo.repoId}...`,
          date: new Date(),
          body: `The repository ${repo.repoId} is going to be refreshed.`,
        });
        state.toasts.push(toast);

        http.post(`/api/repo/${repo.repoId}/refresh`).then(
          (res) => {
            if (res.data.status == "ready") {
              toast.title = `${repo.repoId} is refreshed.`;
            } else {
              toast.title = `Refreshing of ${repo.repoId}.`;
            }
          },
          (error) => {
            toast.title = `Error during the refresh of ${repo.repoId}.`;
            toast.body = error.body;
          }
        );
      };

      state.filtersOpen = false;
      state.fetchError = null;
      function getRepositories() {
        state.fetchError = null;
        http.get("/api/admin/repos", { params: state.query }).then(
          (res) => {
            state.total = res.data.total;
            state.totalPage = Math.ceil(res.data.total / state.query.limit);
            state.repositories = res.data.results;
            state.allSelected = false;
          },
          (err) => {
            state.fetchError = (err && err.data && err.data.error) || "Failed to load repositories";
            console.error(err);
          }
        );
      }
      // Status chips always show real totals: the list endpoint counts only within the
      // active status filter, so ask again with every status enabled (one row).
      function getStatusCounts() {
        const params = Object.assign({}, state.query, { page: 1, limit: 1, ready: true, expired: true, removed: true, error: true, preparing: true });
        http.get("/api/admin/repos", { params }).then((res) => {
          state.statusCounts = res.data.statusCounts || [];
          state.totalSize = res.data.totalSize || 0;
        }, () => {});
      }
      state.showAllStatuses = () => Object.assign(state.query, { ready: true, expired: true, removed: true, error: true, preparing: true, page: 1 });
      installStatusSegments(state, {
        flags: () => state.query,
        keys: ["ready", "preparing", "error", "expired", "removed"],
        count: (k) => k === "preparing" ? state.statusCountFor("preparing") + state.statusCountFor("download")
          : k === "expired" ? state.statusCountFor("expired") + state.statusCountFor("expiring")
          : k === "removed" ? state.statusCountFor("removed") + state.statusCountFor("removing")
          : state.statusCountFor(k),
        onChange: () => { state.query.page = 1; },
      });
      getRepositories();
      getStatusCounts();

      let timeClear = null;
      state.watch(
        "query",
        () => {
          timers.timeout.cancel(timeClear);
          timeClear = timers.timeout(() => { getRepositories(); getStatusCounts(); }, 500);
          const { page, search, ...persisted } = state.query;
          saveFilterPrefs(reposAdminPrefsKey, persisted);
          recomputeChips();
        },
        true
      );
      recomputeChips();
    };

export const usersAdminController = function (state, http, location) {
      const timers = createTimers();
      const listen = createListeners();
      state.Math = Math;
      state.watch("user.status", () => {
        if (state.user == null) {
          location.url("/");
        }
      });
      if (state.user == null) {
        location.url("/");
      }

      state.users = [];
      state.total = -1;
      state.totalPage = 0;
      state.statusCounts = [];
      state.selected = {};
      state.allSelected = false;

      const searchKeyHandler = (e) => {
        if (e.key === "/" && !["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName)) {
          e.preventDefault();
          const el = document.querySelector('.admin-filter-toolbar input[type="search"]');
          el && el.focus();
        }
      };
      listen(document, "keydown", searchKeyHandler);
      state.on("dispose", () => document.removeEventListener("keydown", searchKeyHandler));

      state.clearFilter = (key) => {
        if (key === "dateRange") { state.query.dateFrom = ""; state.query.dateTo = ""; }
        else state.query[key] = "";
        state.query.page = 1;
      };
      state.chips = [];
      const recomputeChipsUsers = () => {
        const out = [];
        if (state.query.role) out.push({ key: "role", label: "Role", value: state.query.role });
        state.chips = out;
      };

      state.statusCountFor = (s) => {
        const row = (state.statusCounts || []).find((c) => c._id === s);
        return row ? row.count : 0;
      };

      state.toggleSortDirection = () => {
        state.query.direction = state.query.direction === "asc" ? "desc" : "asc";
      };
      state.sortBy = (field) => {
        if (state.query.sort === field) {
          state.query.direction = state.query.direction === "asc" ? "desc" : "asc";
        } else {
          state.query.sort = field;
          state.query.direction = "desc";
        }
        state.query.page = 1;
      };
      state.sortIcon = (field) =>
        state.query.sort === field
          ? (state.query.direction === "asc" ? "fa-arrow-up" : "fa-arrow-down")
          : "";

      const usersAdminPrefsKey = "admin.users.filterPrefs";
      const usersAdminDefaults = {
        page: 1,
        limit: 25,
        sort: "username",
        direction: "asc",
        search: "",
        status: "",
        role: "",
        dateFrom: "",
        dateTo: "",
      };
      const savedUsersAdminPrefs = loadFilterPrefs(usersAdminPrefsKey) || {};
      state.query = Object.assign({}, usersAdminDefaults, savedUsersAdminPrefs, {
        page: 1,
        search: "",
      });

      state.selectAllOnPage = () => {
        state.allSelected = !state.allSelected;
        state.users.forEach((u) => {
          state.selected[u.username] = state.allSelected;
        });
      };
      state.selectedCount = () =>
        Object.values(state.selected || {}).filter(Boolean).length;
      state.selectedUsers = () =>
        state.users.filter((u) => state.selected[u.username]);

      state.banUser = (u) => {
        if (!confirm(`Ban user ${u.username}?`)) return;
        http
          .post(`/api/admin/users/${u.username}/ban`)
          .then(getUsers, (err) => console.error(err));
      };
      state.activateUser = (u) => {
        http
          .post(`/api/admin/users/${u.username}/activate`)
          .then(getUsers, (err) => console.error(err));
      };
      state.bulkBan = () => {
        const users = state.selectedUsers();
        if (!users.length) return;
        if (!confirm(`Ban ${users.length} users?`)) return;
        users.forEach((u) => state.banUser(u));
      };

      state.exportCsv = () => {
        const params = new URLSearchParams(
          Object.entries(state.query).filter(([, v]) => v !== "" && v !== false && v != null)
        );
        params.set("format", "csv");
        params.set("limit", "10000");
        window.open("/api/admin/users?" + params.toString(), "_blank");
      };

      state.fetchError = null;
      function getUsers() {
        state.fetchError = null;
        http.get("/api/admin/users", { params: state.query }).then(
          (res) => {
            state.total = res.data.total;
            state.totalPage = Math.ceil(res.data.total / state.query.limit);
            state.users = res.data.results;
            state.statusCounts = res.data.statusCounts || [];
            state.allSelected = false;

          },
          (err) => {
            state.fetchError = (err && err.data && err.data.error) || "Failed to load users";
            console.error(err);
          }
        );
      }
      getUsers();

      let timeClear = null;
      state.watch(
        "query",
        () => {
          timers.timeout.cancel(timeClear);
          timeClear = timers.timeout(getUsers, 500);
          const { page, search, ...persisted } = state.query;
          saveFilterPrefs(usersAdminPrefsKey, persisted);
          recomputeChipsUsers();
        },
        true
      );
      recomputeChipsUsers();
    };

export const userAdminController = function (state, http, location, params) {
      const timers = createTimers();
      watchMetaLines(timers, createListeners());
      state.watch("user.status", () => {
        if (state.user == null) {
          location.url("/");
        }
      });
      if (state.user == null) {
        location.url("/");
      }

      state.userInfo;
      state.repositories = [];
      state.search = "";
      state.selected = {};
      state.allSelected = false;

      const adminUserPrefsKey = "admin.user.filterPrefs";
      const adminUserDefaults = {
        filters: { status: { ready: true, expired: true, removed: true, error: true, preparing: true } },
        sort: "anonymizeDate",
        direction: "desc",
      };
      const savedAdminUserPrefs = loadFilterPrefs(adminUserPrefsKey) || {};
      state.filters = {
        status: Object.assign(
          {},
          adminUserDefaults.filters.status,
          (savedAdminUserPrefs.filters && savedAdminUserPrefs.filters.status) || {}
        ),
      };
      state.query = {
        sort: savedAdminUserPrefs.sort || adminUserDefaults.sort,
        direction: savedAdminUserPrefs.direction || adminUserDefaults.direction,
      };
      state.orderBy = (state.query.direction === "asc" ? "" : "-") + state.query.sort;

      state.sortBy = (field) => {
        if (state.query.sort === field) {
          state.query.direction = state.query.direction === "asc" ? "desc" : "asc";
        } else {
          state.query.sort = field;
          state.query.direction = "desc";
        }
        state.orderBy = (state.query.direction === "asc" ? "" : "-") + state.query.sort;
      };
      state.sortIcon = (field) =>
        state.query.sort === field
          ? (state.query.direction === "asc" ? "fa-arrow-up" : "fa-arrow-down")
          : "";

      state.watch("query", () => {
        saveFilterPrefs(adminUserPrefsKey, {
          filters: state.filters,
          sort: state.query.sort,
          direction: state.query.direction,
        });
      }, true);
      state.watch(
        "filters",
        () => {
          saveFilterPrefs(adminUserPrefsKey, {
            filters: state.filters,
            sort: state.query.sort,
            direction: state.query.direction,
          });
        },
        true
      );

      state.statusCountFor = (s) => {
        return (state.repositories || []).filter((r) => statusGroup(r.status) === s).length;
      };
      installStatusSegments(state, {
        flags: () => state.filters.status,
        keys: ["ready", "preparing", "error", "expired", "removed"],
        count: (k) => state.statusCountFor(k),
      });

      state.repoFiler = (repo) => {
        if (state.filters.status[statusGroup(repo.status)] == false) return false;

        if (state.search.trim().length == 0) return true;

        if (repo.source.fullName.indexOf(state.search) > -1) return true;
        if (repo.repoId.indexOf(state.search) > -1) return true;
        if (repo.statusMessage && repo.statusMessage.indexOf(state.search) > -1) return true;
        if (repo.conference && repo.conference.indexOf(state.search) > -1) return true;

        return false;
      };

      // -------- selection / bulk --------
      state.selectAllOnPage = () => {
        state.allSelected = !state.allSelected;
        (state.filteredRepositories || state.repositories).forEach((r) => {
          state.selected[r.repoId] = state.allSelected;
        });
      };
      state.selectedCount = () =>
        Object.values(state.selected || {}).filter(Boolean).length;
      state.selectedRepos = () =>
        state.repositories.filter((r) => state.selected[r.repoId]);
      state.bulkRefresh = () => {
        const repos = state.selectedRepos();
        if (!repos.length) return;
        if (!confirm(`Force refresh ${repos.length} repositories?`)) return;
        repos.forEach((r) => state.updateRepository(r));
      };
      state.bulkRemoveCache = () => {
        const repos = state.selectedRepos();
        if (!repos.length) return;
        if (!confirm(`Purge cache for ${repos.length} repositories?`)) return;
        repos.forEach((r) => state.removeCache(r));
      };
      state.clearSelection = () => {
        state.selected = {};
        state.allSelected = false;
      };

      // -------- export --------
      state.exportCsv = () => {
        const filtered = (state.filteredRepositories || state.repositories);
        const columns = ["repoId", "status", "statusMessage", "pageView", "anonymizeDate", "source.fullName", "conference", "size.storage"];
        const header = columns.join(",");
        const rows = filtered.map((r) =>
          [r.repoId, r.status, r.statusMessage || "", r.pageView || 0, r.anonymizeDate || "", (r.source && r.source.fullName) || "", r.conference || "", (r.size && r.size.storage) || 0]
            .map((v) => { const s = String(v == null ? "" : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; })
            .join(",")
        );
        const blob = new Blob([header + "\n" + rows.join("\n")], { type: "text/csv" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = params.username + "-repositories.csv";
        a.click();
      };

      state.showStatusMessage = (repo) => {
        const msg = repo.statusMessage || "(no message)";
        window.prompt(`Status message for ${repo.repoId} (${repo.status}):`, msg);
      };

      state.fetchGithubInfo = (repo) => {
        const w = window.open("", "_blank");
        if (w) w.document.write("<pre>Loading GitHub info for " + repo.repoId + "...</pre>");
        http.get("/api/admin/repos/" + repo.repoId + "/github").then(
          (res) => {
            if (w) {
              w.document.open();
              w.document.write(
                "<pre style=\"font:13px monospace;padding:16px;white-space:pre-wrap\">" +
                  JSON.stringify(res.data, null, 2).replace(/[<>]/g, (c) => c === "<" ? "&lt;" : "&gt;") +
                  "</pre>"
              );
              w.document.close();
            }
          },
          (err) => {
            const msg = err && err.data ? JSON.stringify(err.data, null, 2) : String(err);
            if (w) w.document.body.innerHTML = "<pre style=\"color:#B42318;padding:16px\">" + msg + "</pre>";
          }
        );
      };

      function getUserRepositories(username) {
        http.get("/api/admin/users/" + username + "/repos", {}).then(
          (res) => {
            state.repositories = res.data;
          },
          (err) => {
            console.error(err);
          }
        );
      }
      function getUser(username) {
        http.get("/api/admin/users/" + username, {}).then(
          (res) => {
            state.userInfo = res.data;
          },
          (err) => {
            console.error(err);
          }
        );
      }
      getUser(params.username);
      getUserRepositories(params.username);

      state.banUser = () => {
        if (!confirm(`Ban user ${params.username}?`)) return;
        http
          .post(`/api/admin/users/${params.username}/ban`)
          .then(() => getUser(params.username), (err) => console.error(err));
      };
      state.activateUser = () => {
        http
          .post(`/api/admin/users/${params.username}/activate`)
          .then(() => getUser(params.username), (err) => console.error(err));
      };
      state.promoteUser = () => {
        if (!confirm(`Promote ${params.username} to admin?`)) return;
        http
          .post(`/api/admin/users/${params.username}/promote`)
          .then(() => getUser(params.username), (err) => console.error(err));
      };
      state.demoteUser = () => {
        if (!confirm(`Remove admin privileges from ${params.username}?`)) return;
        http
          .post(`/api/admin/users/${params.username}/demote`)
          .then(() => getUser(params.username), (err) => console.error(err));
      };

      state.tokens = [];
      state.tokenForm = { name: "", plaintext: null };

      function loadTokens() {
        http.get("/api/admin/tokens").then(
          (res) => {
            state.tokens = res.data || [];
          },
          (err) => {
            if (err.status !== 401 && err.status !== 403) console.error(err);
          }
        );
      }
      loadTokens();

      state.createToken = () => {
        if (!state.tokenForm.name) return;
        http
          .post("/api/admin/tokens", { name: state.tokenForm.name })
          .then(
            (res) => {
              state.tokenForm.plaintext = res.data.token;
              state.tokenForm.name = "";
              loadTokens();
            },
            (err) => console.error(err)
          );
      };

      state.revokeToken = (t) => {
        if (!confirm(`Revoke token "${t.name}"?`)) return;
        http.delete("/api/admin/tokens/" + t.id).then(
          () => loadTokens(),
          (err) => console.error(err)
        );
      };

      state.removeCache = (repo) => {
        if (!confirm("Remove cached files for " + repo.repoId + "?")) return;
        http.delete("/api/admin/repos/" + repo.repoId).then(
          () => getUserRepositories(params.username),
          (err) => console.error(err)
        );
      };

      state.removeRepository = (repo) => {
        if (!confirm("Remove repository " + repo.repoId + "?")) return;
        http.delete("/api/repo/" + repo.repoId + "/").then(
          () => getUserRepositories(params.username),
          (err) => console.error(err)
        );
      };

      state.updateRepository = (repo) => {
        const toast = reactive({
          title: `Refreshing ${repo.repoId}...`,
          date: new Date(),
          body: `The repository ${repo.repoId} is going to be refreshed.`,
        });
        state.toasts.push(toast);

        http.post(`/api/repo/${repo.repoId}/refresh`).then(
          (res) => {
            if (res.data.status == "ready") {
              toast.title = `${repo.repoId} is refreshed.`;
            } else {
              toast.title = `Refreshing of ${repo.repoId}.`;
            }
          },
          (error) => {
            toast.title = `Error during the refresh of ${repo.repoId}.`;
            toast.body = error.body;
          }
        );
      };

      state.getGitHubRepositories = (force) => {
        http
          .get(`/api/user/${state.userInfo.username}/all_repositories`, {
            params: { force: "1" },
          })
          .then((res) => {
            state.userInfo.repositories = res.data;
          });
      };

      let timeClear = null;
      state.watch(
        "query",
        () => {
          timers.timeout.cancel(timeClear);
          timeClear = timers.timeout(() => {
            getUserRepositories(params.username);
          }, 500);
        },
        true
      );
    };

export const conferencesAdminController = function (state, http, location) {
      const timers = createTimers();
      const listen = createListeners();
      state.Math = Math;
      state.watch("user.status", () => {
        if (state.user == null) {
          location.url("/");
        }
      });
      if (state.user == null) {
        location.url("/");
      }

      state.conferences = [];
      state.total = -1;
      state.totalPage = 0;
      state.statusCounts = [];

      const searchKeyHandler = (e) => {
        if (e.key === "/" && !["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName)) {
          e.preventDefault();
          const el = document.querySelector('.admin-filter-toolbar input[type="search"]');
          el && el.focus();
        }
      };
      listen(document, "keydown", searchKeyHandler);
      state.on("dispose", () => document.removeEventListener("keydown", searchKeyHandler));

      state.clearFilter = (key) => {
        if (key === "dateRange") { state.query.dateFrom = ""; state.query.dateTo = ""; }
        else state.query[key] = "";
        state.query.page = 1;
      };
      state.chips = [];
      const recomputeChipsConf = () => {
        const out = [];
        if (state.query.dateFrom || state.query.dateTo) out.push({ key: "dateRange", label: "Date", value: (state.query.dateFrom || "…") + " – " + (state.query.dateTo || "…") });
        state.chips = out;
      };

      state.statusCountFor = (s) => {
        const row = (state.statusCounts || []).find((c) => c._id === s);
        return row ? row.count : 0;
      };

      state.toggleSortDirection = () => {
        state.query.direction = state.query.direction === "asc" ? "desc" : "asc";
      };
      state.sortBy = (field) => {
        if (state.query.sort === field) {
          state.query.direction = state.query.direction === "asc" ? "desc" : "asc";
        } else {
          state.query.sort = field;
          state.query.direction = "desc";
        }
        state.query.page = 1;
      };
      state.sortIcon = (field) =>
        state.query.sort === field
          ? (state.query.direction === "asc" ? "fa-arrow-up" : "fa-arrow-down")
          : "";

      const confAdminPrefsKey = "admin.conferences.filterPrefs";
      const confAdminDefaults = {
        page: 1,
        limit: 25,
        sort: "name",
        direction: "asc",
        search: "",
        dateFrom: "",
        dateTo: "",
        ready: true,
        expired: true,
        removed: true,
        error: true,
        preparing: true,
      };
      const savedConfAdminPrefs = loadFilterPrefs(confAdminPrefsKey) || {};
      state.query = Object.assign({}, confAdminDefaults, savedConfAdminPrefs, {
        page: 1,
        search: "",
      });

      // pre-fill filters from URL ?search=
      const urlParams = location.search();
      if (urlParams.search) state.query.search = urlParams.search;

      // -------- presets --------
      const confPresetsKey = "admin.conferences.presets";
      state.presets = JSON.parse(localStorage.getItem(confPresetsKey) || "[]");
      state.savePreset = () => {
        const name = window.prompt("Preset name:");
        if (!name) return;
        const snapshot = Object.assign({}, state.query);
        delete snapshot.page;
        state.presets = (state.presets || []).filter((p) => p.name !== name);
        state.presets.push({ name, query: snapshot });
        localStorage.setItem(confPresetsKey, JSON.stringify(state.presets));
      };
      state.applyPreset = (p) => {
        Object.assign(state.query, p.query, { page: 1 });
      };
      state.deletePreset = (p) => {
        state.presets = (state.presets || []).filter((x) => x.name !== p.name);
        localStorage.setItem(confPresetsKey, JSON.stringify(state.presets));
      };

      state.removeConference = (conference) => {
        if (!confirm("Remove conference " + conference.conferenceID + "?")) return;
        http.delete("/api/admin/conferences/" + conference.conferenceID).then(
          () => getConferences(),
          (err) => console.error(err)
        );
      };

      state.exportCsv = () => {
        const params = new URLSearchParams(
          Object.entries(state.query).filter(([, v]) => v !== "" && v !== false && v != null)
        );
        params.set("format", "csv");
        params.set("limit", "10000");
        window.open("/api/admin/conferences?" + params.toString(), "_blank");
      };

      state.fetchError = null;
      function getConferences() {
        state.fetchError = null;
        http.get("/api/admin/conferences", { params: state.query }).then(
          (res) => {
            state.total = res.data.total;
            state.totalPage = Math.ceil(res.data.total / state.query.limit);
            state.conferences = res.data.results;
            state.statusCounts = res.data.statusCounts || [];
          },
          (err) => {
            state.fetchError = (err && err.data && err.data.error) || "Failed to load conferences";
            console.error(err);
          }
        );
      }
      installStatusSegments(state, {
        flags: () => state.query,
        keys: ["ready", "preparing", "error", "expired", "removed"],
        count: (k) => state.statusCountFor(k),
        onChange: () => { state.query.page = 1; },
      });
      getConferences();

      let timeClear = null;
      state.watch(
        "query",
        () => {
          timers.timeout.cancel(timeClear);
          timeClear = timers.timeout(getConferences, 500);
          const { page, search, ...persisted } = state.query;
          saveFilterPrefs(confAdminPrefsKey, persisted);
          recomputeChipsConf();
        },
        true
      );
      recomputeChipsConf();
    };

export const queuesAdminController = function (state, http, location, interval, timeout) {
      const timers = createTimers();
      state.watch("user.status", () => {
        if (state.user == null) location.url("/");
      });
      if (state.user == null) location.url("/");

      state.queueList = [];
      state.jobs = [];
      state.selectedQueue = "download";
      state.selectedStats = null;
      state.range = "1h";
      state.allStates = ["active", "waiting", "delayed", "failed", "completed"];
      state.stateFilter = { active: true, waiting: true, delayed: true, failed: true, completed: true };
      installStatusSegments(state, {
        flags: () => state.stateFilter,
        keys: state.allStates,
        count: (k) => (state.jobs || []).filter((j) => j._state === k).length,
      });
      state.query = {
        search: "",
        autoRefresh: true,
      };

      state.filteredJobs = () => {
        return (state.jobs || []).filter((j) => state.stateFilter[j._state]);
      };

      state.jobProgressPct = (job) => {
        // A completed job is done whatever its last reported progress was (an empty bar beside "Completed" reads as stalled).
        if (job?._state === "completed") return 100;
        if (job && job.progress && typeof job.progress === "object" && typeof job.progress.percent === "number") {
          return Math.max(0, Math.min(100, Math.round(job.progress.percent)));
        }
        if (typeof job.progress === "number") {
          return Math.max(0, Math.min(100, Math.round(job.progress)));
        }
        return null;
      };

      // The Detail column: the stage an active job reports, or why a failed job failed; a dash otherwise.
      const JOB_STAGES = { get_files: "Fetching files", download: "Downloading", downloading: "Downloading", anonymize: "Anonymizing", anonymizing: "Anonymizing", ready: "Ready", removing: "Removing", preparing: "Preparing" };
      state.jobDetail = (job) => {
        if (job?._state === "failed") return statusMsg(job.failedReason || "") || "Failed";
        const stage = job?.progress && typeof job.progress === "object" ? job.progress.status : null;
        if (job?._state === "active" && stage) return JOB_STAGES[stage] || statusMsg(stage);
        return "—";
      };

      state.jobDuration = (job) => {
        if (!job.processedOn) return "—";
        const end = job.finishedOn || Date.now();
        return duration(end - job.processedOn);
      };

      state.metricsPoints = [];

      state.selectQueue = (key) => {
        state.selectedQueue = key;
        getQueues();
        getMetrics();
      };

      state.setRange = (r) => {
        state.range = r;
        getMetrics();
      };

      function getQueues() {
        const params = {
          queue: state.selectedQueue,
          search: state.query.search,
        };
        http.get("/api/admin/queues", { params }).then(
          (res) => {
            state.queueList = res.data.queues || [];
            state.jobs = res.data.jobs || [];
            state.selectedStats = state.queueList.find((q) => q.key === state.selectedQueue) || state.queueList[0] || null;
          },
          (err) => console.error(err)
        );
      }

      function getMetrics() {
        http.get("/api/admin/queues/metrics", {
          params: { queue: state.selectedQueue, range: state.range }
        }).then(
          (res) => {
            state.metricsPoints = res.data.points || [];
            timeout(drawChart, 0);
          },
          (err) => console.error(err)
        );
      }
      getQueues();
      getMetrics();

      const stop = interval(() => {
        if (state.query.autoRefresh) {
          getQueues();
          getMetrics();
        }
      }, 15000);
      state.on("dispose", () => interval.cancel(stop));

      state.refreshNow = function () { getQueues(); getMetrics(); };

      function apiError(err) {
        const msg = (err && err.data && (err.data.message || err.data.error)) || "Request failed";
        state.actionError = msg;
        timeout(() => { state.actionError = null; }, 5000);
        console.error(err);
      }

      state.actionError = null;

      state.removeJob = (job) => {
        http.delete(`/api/admin/queue/${state.selectedQueue}/${job.id}`).then(getQueues, apiError);
      };

      state.retryJob = (job) => {
        http.post(`/api/admin/queue/${state.selectedQueue}/${job.id}`).then(getQueues, apiError);
      };

      state.retryFailed = () => {
        if (!confirm(`Retry all failed jobs in ${state.selectedQueue}?`)) return;
        http.post(`/api/admin/queue/${state.selectedQueue}/retry-failed`).then(getQueues, (err) => console.error(err));
      };

      state.drainSelected = () => {
        if (!confirm(`Drain the ${state.selectedQueue} queue?`)) return;
        http.post(`/api/admin/queue/${state.selectedQueue}/drain`).then(getQueues, (err) => console.error(err));
      };

      state.togglePause = () => {
        const action = state.selectedStats && state.selectedStats.paused ? "resume" : "pause";
        http.post(`/api/admin/queue/${state.selectedQueue}/${action}`).then(getQueues, (err) => console.error(err));
      };

      state.emptyQueue = () => {
        if (!confirm(`Empty the ${state.selectedQueue} queue? This removes ALL jobs.`)) return;
        http.post(`/api/admin/queue/${state.selectedQueue}/empty`).then(getQueues, (err) => console.error(err));
      };

      state.pauseAll = () => {
        if (!confirm("Pause all queues?")) return;
        http.post("/api/admin/queues/pause-all").then(getQueues, (err) => console.error(err));
      };

      let searchClear = null;
      state.watch("query.search", () => {
        timers.timeout.cancel(searchClear);
        searchClear = timers.timeout(getQueues, 350);
      });
      state.expanded = {};
      state.toggleJob = (job) => {
        state.expanded[job.id] = !state.expanded[job.id];
      };

      state.humanTime = (ts) => {
        if (!ts) return "";
        const d = new Date(ts);
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
          + " " + d.toLocaleDateString([], { month: "short", day: "numeric" });
      };

      state.delayCountdown = (ts) => {
        if (!ts) return "";
        var remaining = Math.max(0, Math.ceil((ts - Date.now()) / 1000));
        if (remaining <= 0) return "resuming soon";
        var min = Math.floor(remaining / 60);
        var sec = remaining % 60;
        return "in " + (min > 0 ? min + "m " + sec + "s" : sec + "s");
      };

      function niceScale(max) {
        if (max <= 0) return { ticks: [0], niceMax: 1 };
        const mag = Math.pow(10, Math.floor(Math.log10(max)));
        let step = mag;
        if (max / step < 2) step = mag / 2;
        else if (max / step > 5) step = mag * 2;
        const niceMax = Math.ceil(max / step) * step;
        const ticks = [];
        for (let v = 0; v <= niceMax; v += step) ticks.push(v);
        return { ticks, niceMax };
      }

      function drawChart() {
        var canvas = document.getElementById("q-throughput-chart");
        if (!canvas) return;
        var ctx = canvas.getContext("2d");
        var dpr = window.devicePixelRatio || 1;
        var rect = canvas.parentElement.getBoundingClientRect();
        var marginLeft = 44;
        var marginRight = 44;
        var marginBottom = 22;
        // The plot fills its card, which stretches to the height of the stats panel beside it.
        var totalW = Math.max(200, Math.round(rect.width));
        var totalH = Math.max(180, Math.min(420, Math.round(rect.height) || 180));
        var w = totalW - marginLeft - marginRight;
        var h = totalH - marginBottom;
        canvas.width = totalW * dpr;
        canvas.height = totalH * dpr;
        canvas.style.width = totalW + "px";
        canvas.style.height = totalH + "px";
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        var isDark = document.body.classList.contains("dark-mode");
        var labelColor = "#8A857C";
        var gridColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
        var completedColor = isDark ? "#6FBF8A" : "#2F7D4F";
        var completedFill = isDark ? "rgba(111,191,138,0.12)" : "rgba(47,125,79,0.08)";
        var failedColor = isDark ? "#F08A82" : "#B42318";
        var failedFill = isDark ? "rgba(240,138,130,0.08)" : "rgba(180,35,24,0.06)";
        // One token drives the time line, its seconds axis and its legend key (style.css: --q-time-series).
        var execColor = getComputedStyle(document.body).getPropertyValue("--q-time-series").trim() || (isDark ? "#E0A94A" : "#946512");

        var pts = state.metricsPoints || [];
        if (pts.length === 0) {
          ctx.fillStyle = labelColor;
          ctx.font = "13px Inter, system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("No metrics data yet", totalW / 2, totalH / 2);
          chartState = null;
          return;
        }

        // Data is oldest→newest from the API; chart shows newest on the right
        var completedPts = pts.map(function (p) { return p.completed; });
        var failedPts = pts.map(function (p) { return p.failed; });
        var execPts = pts.map(function (p) { return p.avgMs; });
        if (!completedPts.some(Boolean) && !failedPts.some(Boolean)) {
          ctx.strokeStyle = isDark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)";
          ctx.beginPath(); ctx.moveTo(0, totalH - 18.5); ctx.lineTo(totalW, totalH - 18.5); ctx.stroke();
          ctx.fillStyle = isDark ? "#CFC8BD" : "#4F4A42";
          ctx.font = "500 14px Inter, system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("No jobs processed in this window", totalW / 2, totalH / 2 - 6);
          ctx.fillStyle = labelColor;
          ctx.font = "12.5px Inter, system-ui, sans-serif";
          ctx.fillText("Completed and failed jobs will chart here", totalW / 2, totalH / 2 + 16);
          chartState = null;
          return;
        }
        var maxLen = pts.length;
        var step = w / (maxLen - 1 || 1);

        // Left Y-axis: jobs/min
        var rawMax = Math.max(1, Math.max.apply(null, completedPts), Math.max.apply(null, failedPts));
        var left = niceScale(rawMax);

        // Right Y-axis: avg exec time (ms)
        var execMax = Math.max.apply(null, execPts);
        var right = execMax > 0 ? niceScale(execMax) : { ticks: [0], niceMax: 1 };

        var toY = function (v) { return h - (v / left.niceMax) * (h - 10); };
        var toYr = function (v) { return h - (v / right.niceMax) * (h - 10); };
        var toX = function (i) { return marginLeft + i * step; };

        // Grid + left Y-axis labels (jobs/min)
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.font = "11px Inter, system-ui, sans-serif";
        left.ticks.forEach(function (v) {
          var y = toY(v);
          ctx.strokeStyle = gridColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(marginLeft, y);
          ctx.lineTo(totalW - marginRight, y);
          ctx.stroke();
          ctx.fillStyle = labelColor;
          // The origin is implied by the baseline; a "0" here would collide with the first time label.
          if (v !== 0) ctx.fillText(v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(v), marginLeft - 6, y);
        });

        // Right Y-axis labels (ms)
        if (execMax > 0) {
          ctx.textAlign = "left";
          right.ticks.forEach(function (v) {
            var y = toYr(v);
            ctx.fillStyle = execColor;
            if (v !== 0) ctx.fillText(duration(v), totalW - marginRight + 6, y);
          });
        }

        // X-axis time labels: "now" under the newest point, then whole steps back (1, 2, 5, 10, 15, 30 min, 1, 2, 3,
        // 6, 12 h, 1 d) labelled "<n> ago". Each tick sits on the data point nearest its time, and its label is that
        // point's real age rounded to the step, so a label never claims a time the line doesn't reach.
        var tEnd = pts[maxLen - 1].ts, tStart = pts[0].ts;
        var spanMin = Math.max(0, (tEnd - tStart) / 60000);
        var niceSteps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080];
        var stepMin = niceSteps.find(function (m) { return spanMin / m <= 4; }) || niceSteps[niceSteps.length - 1];
        var fmtSpan = function (m) { return m < 60 ? m + "m" : m < 1440 ? (m / 60) + "h" : (m / 1440) + "d"; };
        var nearestIndex = function (t) {
          var best = 0;
          for (var j = 1; j < maxLen; j++) if (Math.abs(pts[j].ts - t) < Math.abs(pts[best].ts - t)) best = j;
          return best;
        };
        var tolMs = Math.max((tEnd - tStart) / Math.max(1, maxLen - 1) / 2, (tEnd - tStart) * 0.03);
        ctx.textBaseline = "top";
        ctx.fillStyle = labelColor;
        var lastX = Infinity;
        for (var k = 0; k * stepMin * 60000 <= (tEnd - tStart) + tolMs && k < 8; k++) {
          var m = k * stepMin;
          var idx = nearestIndex(tEnd - m * 60000);
          if (k > 0 && Math.abs(pts[idx].ts - (tEnd - m * 60000)) > tolMs + 1) continue;
          var x = toX(idx);
          var label = m === 0 ? "now" : fmtSpan(m) + " ago";
          var width = ctx.measureText(label).width;
          var align = k === 0 ? "right" : idx === 0 ? "left" : "center";
          var labelRight = align === "right" ? x : align === "left" ? x + width : x + width / 2;
          if (labelRight > lastX - 12) continue;
          ctx.textAlign = align;
          ctx.fillText(label, x, h + 6);
          lastX = align === "right" ? x - width : align === "left" ? x : x - width / 2;
        }

        function drawArea(data, yFn, fillStyle, strokeStyle) {
          if (data.length === 0) return;
          ctx.beginPath();
          ctx.moveTo(toX(0), h);
          data.forEach(function (v, i) {
            var x = toX(i), y = yFn(v);
            if (i === 0) ctx.lineTo(x, y);
            else {
              var cx = (toX(i - 1) + x) / 2;
              ctx.bezierCurveTo(cx, yFn(data[i - 1]), cx, y, x, y);
            }
          });
          ctx.lineTo(toX(data.length - 1), h);
          ctx.closePath();
          ctx.fillStyle = fillStyle;
          ctx.fill();
          ctx.beginPath();
          data.forEach(function (v, i) {
            var x = toX(i), y = yFn(v);
            if (i === 0) ctx.moveTo(x, y);
            else {
              var cx = (toX(i - 1) + x) / 2;
              ctx.bezierCurveTo(cx, yFn(data[i - 1]), cx, y, x, y);
            }
          });
          ctx.strokeStyle = strokeStyle;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        drawArea(completedPts, toY, completedFill, completedColor);
        drawArea(failedPts, toY, failedFill, failedColor);
        // Exec time as a line only (no fill) on the right axis
        if (execMax > 0) {
          ctx.beginPath();
          execPts.forEach(function (v, i) {
            var x = toX(i), y = toYr(v);
            if (i === 0) ctx.moveTo(x, y);
            else {
              var cx = (toX(i - 1) + x) / 2;
              ctx.bezierCurveTo(cx, toYr(execPts[i - 1]), cx, y, x, y);
            }
          });
          ctx.strokeStyle = execColor;
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        chartState = { pts: pts, maxLen: maxLen, marginLeft: marginLeft, step: step, totalW: totalW, toX: toX };
      }

      var chartState = null;

      function setupTooltip() {
        var canvas = document.getElementById("q-throughput-chart");
        if (!canvas || canvas._tipBound) return;
        canvas._tipBound = true;

        var tooltip = document.getElementById("q-chart-tooltip");
        var crosshair = document.getElementById("q-chart-crosshair");

        canvas.addEventListener("mousemove", function (e) {
          if (!chartState || !tooltip || !crosshair) return;
          var cs = chartState;
          var rect = canvas.getBoundingClientRect();
          var mx = e.clientX - rect.left;

          var idx = Math.round((mx - cs.marginLeft) / cs.step);
          if (idx < 0 || idx >= cs.maxLen) {
            tooltip.style.display = "none";
            crosshair.style.display = "none";
            return;
          }

          var p = cs.pts[idx];
          var now = cs.pts[cs.pts.length - 1].ts; // same origin as the axis: the series end is "now"
          var minsAgo = Math.round((now - p.ts) / 60000);
          var timeLabel;
          if (minsAgo <= 0) timeLabel = "now";
          else if (minsAgo < 60) timeLabel = minsAgo + "m ago";
          else if (minsAgo < 1440) {
            var hrs = Math.floor(minsAgo / 60);
            var mins = minsAgo % 60;
            timeLabel = hrs + "h" + (mins ? " " + mins + "m" : "") + " ago";
          } else timeLabel = Math.round(minsAgo / 1440) + "d ago";

          var html =
            '<div class="q-tip-time">' + timeLabel + '</div>' +
            '<div class="q-tip-completed">&#9679; completed: ' + p.completed + '/min</div>' +
            '<div class="q-tip-failed">&#9679; failed: ' + p.failed + '/min</div>';
          if (p.avgMs > 0) {
            var dur = duration(p.avgMs);
            html += '<div class="q-tip-exec">&#9679; avg time: ' + dur + '</div>';
          }
          tooltip.innerHTML = html;

          var xPos = cs.toX(idx);
          var tipW = tooltip.offsetWidth;
          var tipLeft = xPos + 10;
          if (tipLeft + tipW > cs.totalW) tipLeft = xPos - tipW - 10;

          tooltip.style.display = "block";
          tooltip.style.left = tipLeft + "px";
          tooltip.style.top = "8px";

          crosshair.style.display = "block";
          crosshair.style.left = xPos + "px";
        });

        canvas.addEventListener("mouseleave", function () {
          if (tooltip) tooltip.style.display = "none";
          if (crosshair) crosshair.style.display = "none";
        });
      }

      state.watch("metricsPoints", function () {
        timeout(setupTooltip, 50);
      });
    };

export const errorsAdminController = function (state, http, location, interval) {
      const timers = createTimers();
      state.watch("user.status", () => {
        if (state.user == null) {
          location.url("/");
        }
      });
      if (state.user == null) {
        location.url("/");
      }

      state.entries = [];
      state.visible = [];
      state.available = true;
      state.cap = 1000;
      state.total = 0;
      state.pageSize = 250;
      state.expanded = {};
      state.detailTab = {};
      state.copyHint = "";
      state.parsedFilterCount = 0;
      state.stats = { last24h: 0, prev24h: 0, delta: 0, severity: { error: 0, warn: 0, info: 0 }, unique: { error: 0, warn: 0, info: 0 }, buckets: [], dropped: 0 };
      state.query = {
        search: "",
        bucket: "",
        sort: "recent",
        group: "code",
        autoRefresh: true,
      };

      state.relTime = (iso) => {
        if (!iso) return "";
        const t = new Date(iso).getTime();
        if (isNaN(t)) return iso;
        const diff = Math.max(0, Date.now() - t);
        const s = Math.floor(diff / 1000);
        if (s < 5) return "just now";
        if (s < 60) return `${s}s ago`;
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        const d = Math.floor(h / 24);
        if (d < 7) return `${d}d ago`;
        return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      };
      state.absTime = (iso) => {
        if (!iso) return "";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      };
      state.absTimeShort = (iso) => {
        if (!iso) return "";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
      };

      // Decorate each entry once with derived display fields. Pre-computing
      // avoids returning new arrays from template functions each digest
      // cycle (which trips Angular's $rootScope:infdig).
      // snake_case-ish identifier looking like an error key. Accepts both
      // pure lowercase ("repo_not_found") and the mixed-case style this
      // codebase uses ("repoId_already_used", "invalid_repoId").
      const errorKeyRe = /^[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+$/;
      function bucketFor(detail, level) {
        const s =
          (detail && (detail.httpStatus || detail.status)) || null;
        if (typeof s === "number") {
          if (s >= 500) return "error";
          if (s === 401 || s === 403 || s === 404) return "info";
          if (s >= 400) return "warn";
        }
        if (level === "error") return "error";
        if (level === "warn") return "warn";
        return "info";
      }
      function decorate(e) {
        const detail = (e.raw || []).find(
          (a) => a && typeof a === "object" && !Array.isArray(a)
        );
        if (detail) {
          if (detail.message && errorKeyRe.test(detail.message)) {
            e.displayMessage = detail.message;
            e.displayContext = e.message;
          } else if (detail.code && errorKeyRe.test(String(detail.code))) {
            e.displayMessage = String(detail.code);
            e.displayContext = e.message;
          } else if (
            detail.name &&
            detail.name !== "AnonymousError" &&
            detail.name !== "Error"
          ) {
            // Plain JS errors (SyntaxError, TypeError, RangeError, ...) — use
            // the class name as the visible code; the original message is
            // shown as italic context.
            e.displayMessage = detail.name;
            e.displayContext = detail.message || e.message;
          } else {
            e.displayMessage = e.message;
          }
          e._status = detail.httpStatus || detail.status || null;
          e._url = detail.url || null;
          e._method = detail.method || null;
          e._repoId = detail.repoId || detail.detail || null;
          e._detail = detail.detail && detail.detail !== e._repoId ? detail.detail : null;
          // Walk into `cause` (and `err` for streamer-style entries) to
          // surface the deepest stack.
          let s = typeof detail.stack === "string" ? detail.stack : null;
          var roots = [detail.cause, detail.err].filter(Boolean);
          for (var ri = 0; !s && ri < roots.length; ri++) {
            var c = roots[ri];
            while (!s && c && typeof c === "object") {
              if (typeof c.stack === "string") s = c.stack;
              c = c.cause;
            }
          }
          e._stack = s;
        } else {
          e.displayMessage = e.message;
          e._status = null;
          e._url = null;
          e._stack = null;
        }
        e._bucket = bucketFor(detail, e.level);
        e._detailJson = renderDisplayPayload(e, detail);
        return e;
      }

      // Build a curated, column-aligned JSON payload for the Raw tab. Mirrors
      // the reference admin design: name / code / kind / httpStatus / module /
      // detail / url / ts on aligned colons. We can't just JSON.stringify the
      // raw entry because it includes the human "anonymous error" wrapper
      // arg and the keys aren't column-aligned.
      function renderDisplayPayload(entry, detail) {
        const fields = [];
        const push = (k, v) => {
          if (v === undefined || v === null || v === "") return;
          fields.push([k, v]);
        };
        push("name", detail && detail.name);
        push("code", entry.displayMessage || (detail && detail.message));
        if (entry._bucket) push("kind", entry._bucket);
        push("httpStatus", detail && detail.httpStatus);
        if (detail && detail.status && !(detail.httpStatus)) push("status", detail.status);
        push("module", entry.module);
        // AnonymousError.detail() can return a JSON-encoded string for
        // structured payloads (e.g. {"repoId":"...","terms":[],"fullName":...}).
        // Try to parse it so the renderer can pretty-print it multi-line
        // instead of dumping an unreadable escape-soup blob.
        let detailValue = detail && detail.detail;
        if (typeof detailValue === "string") {
          const trimmed = detailValue.trim();
          if (trimmed[0] === "{" || trimmed[0] === "[") {
            try {
              detailValue = JSON.parse(detailValue);
            } catch {
              /* leave as string */
            }
          }
        }
        push("detail", detailValue);
        push("repoId", detail && detail.repoId);
        push("filePath", detail && detail.filePath);
        push("upstreamStatus", detail && detail.upstreamStatus);
        push("upstreamBody", detail && detail.upstreamBody);
        push("url", entry._url);
        push("err", detail && detail.err);
        push("cause", detail && !detail.err && detail.cause);
        push("ts", entry.ts);
        if (!fields.length) return JSON.stringify(entry, null, 2);
        const keyW = fields.reduce((w, f) => Math.max(w, f[0].length), 0);
        const lines = ["{"];
        fields.forEach(([k, v], i) => {
          const key = `"${k}":`.padEnd(keyW + 3, " ");
          const prefix = `  ${key} `;
          const comma = i < fields.length - 1 ? "," : "";
          let val;
          if (v && typeof v === "object") {
            // Indent continuation lines under the value column so the nested
            // object reads like a column instead of breaking flow.
            const pad = " ".repeat(prefix.length);
            val = JSON.stringify(v, null, 2)
              .split("\n")
              .map((ln, idx) => (idx === 0 ? ln : pad + ln))
              .join("\n");
          } else if (typeof v === "number" || typeof v === "boolean") {
            val = String(v);
          } else {
            val = JSON.stringify(v);
          }
          lines.push(`${prefix}${val}${comma}`);
        });
        lines.push("}");
        return lines.join("\n");
      }

      // Lightweight filter parser. Pulls `key:value` and `status:>=400` style
      // tokens out of the search box; everything else falls back to a free
      // text contains-match against the rendered fields.
      function parseFilter(input) {
        const filters = [];
        let free = "";
        const re = /(\w+):(>=|<=|!=|>|<|=)?([^\s]+)/g;
        let lastEnd = 0;
        let m;
        while ((m = re.exec(input))) {
          free += input.slice(lastEnd, m.index);
          lastEnd = re.lastIndex;
          filters.push({ key: m[1], op: m[2] || "=", val: m[3] });
        }
        free += input.slice(lastEnd);
        return { filters, free: free.trim().toLowerCase() };
      }
      function matchFilter(row, parsed) {
        for (const f of parsed.filters) {
          const cmp = (a, b, op) => {
            const an = parseFloat(a);
            const bn = parseFloat(b);
            if (op === "=") return String(a) === String(b);
            if (op === "!=") return String(a) !== String(b);
            if (op === ">=") return an >= bn;
            if (op === "<=") return an <= bn;
            if (op === ">") return an > bn;
            if (op === "<") return an < bn;
            return true;
          };
          let v;
          if (f.key === "code") v = row.displayMessage;
          else if (f.key === "module") v = row.module;
          else if (f.key === "status") v = row._status;
          else if (f.key === "url") v = row._url;
          else if (f.key === "repo") v = row._repoId;
          else if (f.key === "level") v = row.level;
          else continue;
          if (v == null) return false;
          if (!cmp(v, f.val, f.op)) return false;
        }
        if (parsed.free) {
          const hay = (
            (row.displayMessage || "") + " " +
            (row.module || "") + " " +
            (row._url || "") + " " +
            JSON.stringify(row.raw || [])
          ).toLowerCase();
          if (hay.indexOf(parsed.free) === -1) return false;
        }
        return true;
      }

      function recompute() {
        const parsed = parseFilter(state.query.search || "");
        state.parsedFilterCount = parsed.filters.length;
        const bucket = state.query.bucket;
        let rows = state.entries.filter((e) => {
          if (bucket && e._bucket !== bucket) return false;
          return matchFilter(e, parsed);
        });

        const group = state.query.group;
        if (group) {
          const keyOf = (r) =>
            group === "module" ? r.module : (r.displayMessage || r.message || "_");
          const map = new Map();
          for (const r of rows) {
            const k = keyOf(r);
            if (!map.has(k)) {
              const seed = Object.assign({}, r);
              seed._key = `${group}:${k}`;
              seed._related = [r];
              seed._firstSeen = r.ts;
              seed._lastHourCount = 0;
              seed.count = 1;
              map.set(k, seed);
            } else {
              const g = map.get(k);
              g.count++;
              g._related.push(r);
              if (new Date(r.ts) > new Date(g.ts)) {
                g.ts = r.ts;
                g._url = r._url;
                g._status = r._status;
              }
              if (new Date(r.ts) < new Date(g._firstSeen)) g._firstSeen = r.ts;
            }
          }
          // count "this hour"
          const cutoffH = Date.now() - 3600 * 1000;
          for (const g of map.values()) {
            g._lastHourCount = g._related.filter((r) => new Date(r.ts).getTime() >= cutoffH).length;
          }
          rows = Array.from(map.values());
        } else {
          rows = rows.map((r, i) => {
            r._key = "row:" + i + ":" + r.ts;
            r._related = [r];
            r._firstSeen = r.ts;
            r._lastHourCount = 0;
            r.count = 1;
            return r;
          });
        }

        // Errors surface first, then warnings, then routine info; within a level, the chosen order.
        const rank = (r) => ({ error: 0, warn: 1, info: 2 })[r._bucket] ?? 1;
        if (state.query.sort === "count") {
          rows.sort((a, b) => rank(a) - rank(b) || b.count - a.count || new Date(b.ts) - new Date(a.ts));
        } else {
          rows.sort((a, b) => rank(a) - rank(b) || new Date(b.ts) - new Date(a.ts));
        }
        state.visible = rows;
        // A filter that matches nothing in the loaded window keeps reading older pages
        // (bounded) so a 5xx counted in the tiles is not reported as "No errors captured".
        const filtering = !!(state.query.bucket || (state.query.search || "").trim());
        // The default view also reads on until the server errors counted in the tiles appear.
        const errorsHidden = !filtering && (state.stats?.severity?.error || 0) > 0 && !rows.some((r) => r._bucket === "error") && state.entries.length < 1500;
        if (((filtering && !rows.length) || errorsHidden) && state.canLoadMore?.() && !state._autoLoading && state.entries.length < 2500) {
          state._autoLoading = true;
          loadEntries(true);
        }
      }

      function loadEntries(append) {
        // On auto-refresh after the user has paginated ("Load older"),
        // request the SAME-sized window from the head so we don't blow away
        // their loaded tail. Newer entries take the top, the oldest visible
        // ones drop off naturally as the redis list rotates.
        const offset = append ? state.entries.length : 0;
        const limit = append
          ? state.pageSize
          : Math.max(state.pageSize, state.entries.length || state.pageSize);
        http
          .get("/api/admin/errors", { params: { offset, limit } })
          .then(
            (res) => {
              const next = (res.data.entries || []).map(decorate);
              state.entries = append ? state.entries.concat(next) : next;
              state.available = !!res.data.available;
              state.cap = res.data.max || state.cap;
              state.total = res.data.total || state.entries.length;
              state._autoLoading = false;
              recompute();
            },
            (err) => { state._autoLoading = false; console.error(err); }
          );
      }
      state.loadMore = () => loadEntries(true);
      state.canLoadMore = () => state.entries.length < state.total;
      function loadStats() {
        http.get("/api/admin/errors/stats").then(
          (res) => {
            const s = res.data || {};
            const delta = s.prev24h ? Math.round(((s.last24h - s.prev24h) / s.prev24h) * 100) : 0;
            state.stats = {
              last24h: s.last24h || 0,
              prev24h: s.prev24h || 0,
              delta,
              severity: s.severity || { error: 0, warn: 0, info: 0 },
              unique: s.unique || { error: 0, warn: 0, info: 0 },
              buckets: s.buckets || [],
              dropped: s.dropped || 0,
            };
            recompute();
          },
          (err) => console.error(err)
        );
      }
      function load() {
        loadEntries();
        loadStats();
      }

      // Volume chart: errors and warnings carry the height (scaled to their own peak, up to 44px);
      // routine info traffic is a faint band on top, capped at 16px. Exact counts are in the tooltip.
      state.barPx = (b, key) => {
        const all = state.stats.buckets || [];
        let maxEW = 0, maxInfo = 0;
        for (const x of all) { maxEW = Math.max(maxEW, (x.error || 0) + (x.warn || 0)); maxInfo = Math.max(maxInfo, x.info || 0); }
        const part = b[key] || 0;
        if (!part) return 0;
        if (key === "info") return maxInfo ? Math.max(2, Math.round((part / maxInfo) * (maxEW ? 16 : 60))) : 0;
        const ew = (b.error || 0) + (b.warn || 0);
        const h = Math.round((ew / maxEW) * 44);
        return Math.max(4, Math.round((part / ew) * h));
      };
      state.bucketTitle = (b) => {
        const t = new Date(b.hour);
        return `${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${b.error || 0} err · ${b.warn || 0} warn · ${b.info || 0} info`;
      };

      state.toggle = (row) => {
        state.expanded[row._key] = !state.expanded[row._key];
      };
      state.setBucket = (b) => {
        state.query.bucket = b;
      };

      state.refreshNow = load;
      state.clearAll = () => {
        if (!confirm("Clear all captured errors?")) return;
        http.delete("/api/admin/errors").then(load, (err) => console.error(err));
      };
      state.exportCsv = () => {
        const cols = ["ts", "level", "module", "displayMessage", "_status", "_url", "_repoId"];
        const lines = [cols.join(",")];
        for (const r of state.visible) {
          lines.push(cols.map((c) => {
            const v = r[c] == null ? "" : String(r[c]);
            return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
          }).join(","));
        }
        const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `errors-${new Date().toISOString().slice(0, 19)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      };
      function flashCopy(label) {
        state.copyHint = `${label} copied`;
        timers.timeout(() => { state.copyHint = "";  }, 1500);
      }
      state.copyJson = (row) => {
        navigator.clipboard.writeText(row._detailJson).then(() => flashCopy("JSON"));
      };
      state.copyCurl = (row) => {
        if (!row._url) return;
        const method = row._method || "GET";
        const cmd = `curl -X ${method} '${window.location.origin}${row._url}'`;
        navigator.clipboard.writeText(cmd).then(() => flashCopy("curl"));
      };

      load();
      const stop = interval(() => {
        if (state.query.autoRefresh) load();
      }, 15000);
      state.on("dispose", () => interval.cancel(stop));

      state.watch("query.search", recompute);
      state.watch("query.bucket", recompute);
      state.watch("query.sort", recompute);
      state.watch("query.group", recompute);
    };

export const overviewAdminController = function (state, http, location, interval) {
      state.Math = Math;
      state.watch("user.status", () => {
        if (state.user == null) location.url("/");
      });
      if (state.user == null) { location.url("/"); return; }

      state.data = null;
      state.loading = true;
      state.error = null;
      state.performance = null;
      state.performanceMinutes = 15;
      state.performanceTab = "routes";
      state.cacheReport = null;
      state.cacheError = null;
      state.cacheMinutes = 60;
      state.cacheTraffic = "all";
      // The overview is split into views; the hash keeps the chosen one on reload.
      state.ovView = ["performance", "cache"].includes((window.location.hash || "").slice(1)) ? window.location.hash.slice(1) : "summary";
      state.setOvView = function (view) {
        state.ovView = view;
        try { window.history.replaceState(null, "", view === "summary" ? window.location.pathname : "#" + view); } catch (e) { /* ignore */ }
      };
      var cacheLoading = false;
      state.loadCache = function () {
        if (cacheLoading) return;
        cacheLoading = true;
        var minutes = state.cacheMinutes;
        http.get("/api/admin/cache", { params: { minutes: minutes } }).then(function (r) {
          if (minutes !== state.cacheMinutes) return;
          state.cacheReport = r.data;
          state.cacheError = r.data.available ? null : (r.data.reason || "Cache monitoring is unavailable.");
        }, function () {
          state.cacheError = "Could not refresh cache monitoring. Displayed values may be stale.";
        }).finally(function () {
          cacheLoading = false;
          if (minutes !== state.cacheMinutes) state.loadCache();
        });
      };
      state.cacheRows = function () {
        return (state.cacheReport?.rows || []).filter(function (row) {
          return state.cacheTraffic === "all" || row.traffic === state.cacheTraffic;
        });
      };
      state.cacheRate = function (prefix, field) {
        var rows = state.cacheRows();
        var sum = function (name) { return rows.filter(function (r) { return r.name === name; }).reduce(function (n, r) { return n + r[field]; }, 0); };
        var hits = sum(prefix + "_hit"), misses = sum(prefix + "_miss");
        return hits + misses ? (100 * hits / (hits + misses)).toFixed(1) + "%" : "No samples";
      };
      state.cacheEventName = function (name) { return name.replaceAll("_", " "); };
      state.cacheP95 = function (row) {
        var count = 0, bounds = state.cacheReport?.latencyBucketsMs || [];
        if (!row.count) return "No samples";
        if (!row.ms) return "Not timed";
        for (var i = 0; i <= bounds.length; i++) {
          count += row["b" + i] || 0;
          if (count >= Math.ceil(row.count * 0.95)) return i < bounds.length ? "≤ " + duration(bounds[i]) : "> 10\u202Fs";
        }
        return "No samples";
      };
      // The alert names only the metrics that are actually flagged (> 90%).
      state.healthAlert = function () {
        const sys = (state.data && state.data.system) || {};
        const hot = [["Memory", sys.memPercent], ["Disk", sys.diskPercent]].filter(([, v]) => v > 90);
        if (!hot.length) return "";
        const list = hot.map(([n, v]) => n + " is at " + v + "%").join(" and ");
        return list + ". New anonymizations may fail until " + (hot.length > 1 ? "they drop." : "it drops.");
      };
      state.performanceError = null;
      // 18400 ms reads better as 18.4 s once a value passes one second.
      state.formatMs = function (ms) {
        if (ms == null) return "";
        return duration(ms);
      };
      state.latencyBound = function (row, field) {
        if (!row.count) return "No samples";
        return row[field] == null ? "> 60\u202Fs" : "\u2264 " + state.formatMs(row[field]);
      };
      state.firstByteBound = function (row) {
        return state.latencyBound({ count: row.firstByteCount, p95UpperMs: row.firstByteP95UpperMs }, "p95UpperMs");
      };
      state.sampleAge = function (sample) { return Math.max(0, Math.round((Date.now() - sample.sampledAt) / 1000)); };
      state.peakRss = function (sample) {
        return (state.performance.runtimeSeries || []).filter(function (point) { return point.instance === sample.instance; })
          .reduce(function (peak, point) { return Math.max(peak, point.rss); }, sample.memory.rss);
      };
      state.performanceWarning = function (sample) {
        return state.sampleAge(sample) > 45 || sample.droppedBatches || sample.droppedMetrics ||
          sample.sockets?.closeWait > 0 || sample.eventLoop?.p95Ms > 100 ||
          sample.memoryLimitBytes && sample.memory.rss > sample.memoryLimitBytes * 0.8;
      };
      var performanceLoading = false;
      state.loadPerformance = function () {
        var minutes = state.performanceMinutes;
        if (state.performance?.windowMinutes && state.performance.windowMinutes !== minutes) state.performance = null;
        if (performanceLoading) return;
        performanceLoading = true;
        http.get("/api/admin/performance", { params: { minutes: minutes } }).then(function (r) {
          if (minutes !== state.performanceMinutes) return;
          state.performance = r.data;
          state.performanceError = r.data.available ? null : "Performance monitoring is unavailable. Request history may be incomplete.";
        }, function () {
          if (minutes !== state.performanceMinutes) return;
          state.performanceError = "Could not refresh performance monitoring. Displayed samples may be stale.";
        }).finally(function () {
          performanceLoading = false;
          if (minutes !== state.performanceMinutes) state.loadPerformance();
        });
      };

      function humanBytes(b) {
        if (b == null) return "—";
        var units = ["B","KB","MB","GB","TB"];
        var i = 0;
        var v = b;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return v.toFixed(i > 0 ? 1 : 0).replace(/\.0$/, "") + " " + units[i];
      }
      state.humanBytes = humanBytes;

      function humanDuration(seconds) {
        if (!seconds) return "—";
        var d = Math.floor(seconds / 86400);
        var h = Math.floor((seconds % 86400) / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        if (d > 0) return d + "d " + (h < 10 ? "0" : "") + h + "h";
        if (h > 0) return h + "h " + (m < 10 ? "0" : "") + m + "m";
        return m + "m";
      }
      state.humanDuration = humanDuration;

      function humanNum(n) {
        if (n == null) return "—";
        if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
        if (n >= 1000) return (n / 1000).toFixed(1) + "K";
        return String(n);
      }
      state.humanNum = humanNum;

      state.queueTotal = function (q) {
        if (!q) return 0;
        return (q.waiting || 0) + (q.active || 0) + (q.delayed || 0) + (q.failed || 0);
      };

      state.statusCount = function (status) {
        if (!state.data || !state.data.repos) return 0;
        var bd = state.data.repos.statusBreakdown || [];
        for (var i = 0; i < bd.length; i++) {
          if (bd[i]._id === status) return bd[i].count;
        }
        return 0;
      };

      state.barPct = function (status) {
        var total = state.data && state.data.repos ? state.data.repos.total : 0;
        if (!total) return 0;
        var names = [status];
        if (status === "expired") names.push("expiring");
        if (status === "removed") names.push("removing");
        if (status === "preparing") names.push("download");
        var sum = 0;
        names.forEach(function (n) { sum += state.statusCount(n); });
        // A zero count draws no segment; a tiny non-zero count still gets a visible sliver.
        return sum ? Math.max(0.4, (sum / total) * 100) : 0;
      };

      // Real errors are 5xx + 4xx; Info entries are logged but never counted as errors.
      state.realErrors = function () {
        var sev = state.data && state.data.errors && state.data.errors.severity;
        if (!sev) return 0;
        return (sev.error || 0) + (sev.warn || 0);
      };
      // Each bar is its share of the real errors.
      state.errPct = function (key) {
        if (!state.data || !state.data.errors) return 0;
        var total = state.realErrors();
        return total ? ((state.data.errors.severity[key] || 0) / total) * 100 : 0;
      };

      // Hourly real errors (5xx + 4xx) for the last 24 hours, from /api/admin/errors/stats.
      state.errorHours = function () {
        var rows = (state.errorStats && state.errorStats.buckets) || [];
        var max = rows.reduce(function (m, b) { return Math.max(m, (b.error || 0) + (b.warn || 0)); }, 0);
        return rows.map(function (b) {
          var n = (b.error || 0) + (b.warn || 0);
          var h = new Date(b.hour - 3600 * 1000);
          return {
            key: b.hour,
            pct: max && n ? Math.max(6, (n / max) * 100) : 0,
            errPct: max ? ((b.error || 0) / max) * 100 : 0,
            warnPct: max ? ((b.warn || 0) / max) * 100 : 0,
            bad: (b.error || 0) > 0,
            zero: !n,
            title: String(h.getHours()).padStart(2, "0") + ":00 · " + (b.error || 0) + " 5xx, " + (b.warn || 0) + " 4xx",
          };
        });
      };

      state.errorHoursPeak = function () {
        var rows = (state.errorStats && state.errorStats.buckets) || [];
        return rows.reduce(function (m, b) { return Math.max(m, (b.error || 0) + (b.warn || 0)); }, 0);
      };

      function computeDailyHistory(history) {
        var rows = history || [];
        return rows.map(function (d, i) {
          var previous = rows[i - 1] || {};
          var row = Object.assign({}, d);
          row.dailyRepositories = i ? Math.max(0, (d.nbRepositories || 0) - (previous.nbRepositories || 0)) : 0;
          row.dailyUsers = i ? Math.max(0, (d.nbUsers || 0) - (previous.nbUsers || 0)) : 0;
          row.dailyPageViews = i ? Math.max(0, (d.nbPageViews || 0) - (previous.nbPageViews || 0)) : 0;
          return row;
        });
      }

      function todayDailyStats(history) {
        var latest = history && history.length ? history[history.length - 1] : {};
        return {
          repositories: latest.dailyRepositories || 0,
          users: latest.dailyUsers || 0,
          pageViews: latest.dailyPageViews || 0,
        };
      }

      // Always show a full 30-day axis; days before data exists are empty slots.
      function padHistory(rows, days) {
        if (!rows || !rows.length) return rows;
        var last = new Date(rows[rows.length - 1].date);
        if (isNaN(last)) return rows;
        var byDay = {};
        rows.forEach(function (r) { byDay[new Date(r.date).toISOString().slice(0, 10)] = r; });
        var out = [];
        for (var i = days - 1; i >= 0; i--) {
          var dt = new Date(last.getTime() - i * 86400000);
          var key = dt.toISOString().slice(0, 10);
          out.push(byDay[key] || { date: dt.toISOString(), _empty: true, dailyPageViews: 0, dailyRepositories: 0, dailyUsers: 0, nbUsers: 0 });
        }
        return out;
      }
      var historyMaxes = {};
      state.historyMax = function (field) { return historyMaxes[field] || 0; };
      var historyMins = {};
      // Top of the value scale: a round number at or above the peak whose half is an integer
      // (2 -> 2, 7 -> 8, 22 -> 30, 161 -> 200), so the 0 / mid / max ticks are whole numbers.
      state.axisMax = function (field) {
        var max = historyMaxes[field] || 0;
        if (max <= 2) return 2;
        if (max <= 10) return Math.ceil(max / 2) * 2;
        var unit = Math.pow(10, Math.floor(Math.log10(max)));
        return Math.ceil(max / unit) * unit;
      };
      state.historyBarH = function (d, field) {
        if (!d || !historyMaxes[field]) return 0;
        // Zero (or missing) is 0px: the baseline is drawn separately. A non-zero day keeps at least 1px.
        if (!d[field]) return 0;
        return Math.max(1, Math.round((d[field] / state.axisMax(field)) * 140));
      };
      state.historyRange = function (field) {
        return { min: historyMins[field], max: historyMaxes[field] };
      };
      var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      state.historyLabel = function (d) {
        if (!d || !d.date) return "";
        var dt = new Date(d.date);
        return MONTHS[dt.getUTCMonth()] + " " + dt.getUTCDate();
      };
      state.historyHasMissing = function () {
        return !!(state.data && state.data.history || []).some(function (d) { return d && d._empty; });
      };
      state.firstDataIndex = function () {
        var rows = (state.data && state.data.history) || [];
        for (var i = 0; i < rows.length; i++) if (!rows[i]._empty) return i;
        return rows.length;
      };
      state.usersFirst = function () {
        var rows = (state.data && state.data.history) || [];
        var i = state.firstDataIndex();
        return rows[i] ? rows[i].nbUsers || 0 : 0;
      };
      state.usersGained = function () {
        var rows = (state.data && state.data.history) || [];
        return rows.reduce(function (sum, d) { return sum + (d._empty ? 0 : d.dailyUsers || 0); }, 0);
      };
      // A cumulative total under 10 users reads better as a number than as a chart.
      state.usersTiny = function () { return (historyMaxes.nbUsers || 0) < 10; };
      // Cumulative users as a step line / area anchored at 0, in a viewBox of (days x 140).
      // A cumulative series on a 0-based axis is a flat slab; zoom the axis to the 30-day range
      // (two "nice" steps that contain every value) so the growth is visible.
      state.userAxis = function () {
        var rows = ((state.data && state.data.history) || []).filter(function (d) { return d && !d._empty && d.nbUsers != null; });
        if (!rows.length) return { lo: 0, hi: 1 };
        var lo = Math.min.apply(null, rows.map(function (d) { return d.nbUsers; }));
        var hi = Math.max.apply(null, rows.map(function (d) { return d.nbUsers; }));
        var span = Math.max(hi - lo, 1);
        var p = Math.pow(10, Math.floor(Math.log10(span / 2)));
        var steps = [1, 2, 2.5, 5, 10, 20, 25, 50, 100].map(function (m) { return m * p; });
        for (var i = 0; i < steps.length; i++) {
          var a = Math.floor(lo / steps[i]) * steps[i];
          if (a + 2 * steps[i] >= hi) return { lo: a, hi: a + 2 * steps[i] };
        }
        return { lo: 0, hi: state.axisMax("nbUsers") };
      };
      state.userStepPath = function (area) {
        var rows = (state.data && state.data.history) || [];
        var ax = state.userAxis();
        var max = historyMaxes.nbUsers ? ax.hi - ax.lo : 0;
        var start = state.firstDataIndex();
        if (!max || start >= rows.length) return "";
        var y = function (v) { return (140 - (((v || 0) - ax.lo) / max) * 140).toFixed(2); };
        var d = area ? "M" + start + " 140" : "";
        for (var i = start; i < rows.length; i++) {
          var yy = y(rows[i].nbUsers);
          d += (d ? " L" : "M") + i + " " + yy + " L" + (i + 1) + " " + yy;
        }
        if (area) d += " L" + rows.length + " 140 Z";
        return d;
      };

      function load() {
        state.loadPerformance();
        state.loadCache();
        http.get("/api/admin/errors/stats").then(function (r) { state.errorStats = r.data; }, function () { state.errorStats = null; });
        http.get("/api/admin/overview").then(function (r) {
          r.data.history = computeDailyHistory(r.data.history);
          r.data.daily = {
            today: todayDailyStats(r.data.history),
          };
          r.data.history = padHistory(r.data.history, 30);
          r.data.daily = {
            today: todayDailyStats(r.data.history),
          };
          state.data = r.data;
          state.loading = false;
          state.error = null;
          historyMaxes = {};
          historyMins = {};
          (r.data.history || []).forEach(function (d) {
            ["dailyPageViews", "dailyRepositories", "dailyUsers", "nbUsers"].forEach(function (k) {
              if (!historyMaxes[k] || d[k] > historyMaxes[k]) historyMaxes[k] = d[k];
              if (historyMins[k] == null || d[k] < historyMins[k]) historyMins[k] = d[k];
            });
          });
        }, function (err) {
          state.loading = false;
          state.error = (err.data && err.data.error) || "Failed to load overview";
        });
      }

      load();
      var stop = interval(load, 30000);
      state.on("dispose", function () { interval.cancel(stop); });
    };

// Admin repository meta lines ([data-meta-fit]): one fixed order (source · ref · conference · size · terms). Items
// that don't fit on the line are hidden from the end, and a "+N" chip says how many, its tooltip listing them.
function fitMetaLine(line) {
  const chip = line.querySelector(":scope > .meta-more");
  const items = [...line.querySelectorAll(":scope > .meta-item")];
  items.forEach((el) => { el.removeAttribute("data-meta-hidden"); });
  if (chip) { chip.hidden = true; chip.textContent = ""; chip.removeAttribute("title"); chip.removeAttribute("aria-label"); }
  if (!line.clientWidth) return;
  // Measure with the source at its natural width, so the tail yields before the repository name does.
  line.classList.add("is-fitting");
  if (line.scrollWidth <= line.clientWidth + 1) { line.classList.remove("is-fitting"); return; }
  const hidden = [];
  for (let i = items.length - 1; i >= 0 && line.scrollWidth > line.clientWidth + 1; i--) {
    items[i].setAttribute("data-meta-hidden", "");
    hidden.unshift(items[i]);
    if (chip) {
      const names = hidden.map((el) => el.dataset.metaLabel || el.textContent.trim().replace(/\s+/g, " "));
      chip.hidden = false;
      chip.textContent = "+" + hidden.length;
      chip.title = names.join(" · ");
      chip.setAttribute("aria-label", hidden.length + " more: " + names.join(", "));
    }
  }
  line.classList.remove("is-fitting");
}
// Fits every meta line in the document while the calling controller's scope lives: on render changes, resize and
// font load. The observer and listener are released with the scope (no work after the view is gone).
function watchMetaLines(timers, listen) {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined" || !document.body) return;
  let queued = false;
  let observer = null;
  const fitAll = () => {
    queued = false;
    if (!observer) return;
    document.querySelectorAll("[data-meta-fit]").forEach(fitMetaLine);
    observer.takeRecords();
  };
  const queue = () => { if (!queued && observer) { queued = true; timers.timeout(fitAll, 30); } };
  observer = new MutationObserver((records) => {
    if (records.some((r) => !(r.target.closest && r.target.closest(".meta-more")))) queue();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  onScopeDispose(() => { observer.disconnect(); observer = null; });
  listen(window, "resize", queue);
  if (document.fonts?.ready) document.fonts.ready.then(queue);
  queue();
}

// Billing: subscriptions, sales and webhook health. Amounts arrive in minor units per currency
// (Stripe's unit_amount) and are never added across currencies.
const ZERO_DECIMAL = ["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"];
export const BILLING_FAMILIES = [
  { id: "subscription", label: "Subscriptions" },
  { id: "repository", label: "Repository purchases" },
  { id: "conference", label: "Conferences" },
];
// Names from src/core/billing/config.ts, used until the summary (which carries them) arrives.
const BILLING_PLAN_NAMES = { author_monthly: "Author monthly", author_annual: "Author annual", author_pass: "Live updates", repo_extend: "Extended expiration",
  repo_never: "Never expire", repo_slot: "Extra repository", repo_pack: "Paper pack", conference_workshop: "Workshop", conference: "Conference", conference_large: "Large conference" };
export function moneyParts(amounts) {
  return Object.entries(amounts || {}).filter(([, v]) => v).sort((a, b) => b[1] - a[1]).map(([currency, minor]) => {
    const value = ZERO_DECIMAL.includes(currency) ? minor : minor / 100;
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(value); }
    catch (e) { return value + " " + currency.toUpperCase(); }
  });
}
export const billingAdminController = function (state, http, location) {
      const timers = createTimers();
      state.Math = Math;
      state.watch("user.status", () => { if (state.user == null) location.url("/"); });
      if (state.user == null) { location.url("/"); return; }

      state.families = BILLING_FAMILIES;
      state.periods = [{ id: "7d", label: "7 days" }, { id: "30d", label: "30 days" }, { id: "90d", label: "90 days" }, { id: "12m", label: "12 months" }, { id: "all", label: "All time" }];
      const savedPeriod = (() => { try { return localStorage.getItem("admin.billing.period"); } catch (e) { return null; } })();
      state.period = state.periods.some((p) => p.id === savedPeriod) ? savedPeriod : "30d";
      state.summary = null;
      state.summaryError = null;
      state.summaryLoading = true;

      state.periodLabel = () => (state.periods.find((p) => p.id === state.period) || {}).label || "";
      // "in 30 days" reads wrong for All time.
      state.periodPhrase = () => state.period === "all" ? "all time" : "last " + state.periodLabel();
      state.money = (amounts) => moneyParts(amounts);
      state.moneyText = (amounts, empty = "—") => moneyParts(amounts).join(" · ") || empty;
      state.revenueOn = () => !!state.summary?.revenue?.available;
      state.planName = (id) => ((state.summary?.plans || []).find((p) => p.planId === id) || {}).name || BILLING_PLAN_NAMES[id] || id;

      // Stacked sales chart: one column per bucket, scaled to a rounded axis maximum.
      state.bucketTotal = (d) => d ? d.subscription + d.repository + d.conference : 0;
      state.chartMax = () => {
        const peak = Math.max(0, ...(state.summary?.series || []).map(state.bucketTotal));
        if (peak <= 4) return 4;
        const step = Math.pow(10, Math.floor(Math.log10(peak)));
        // An even maximum keeps the midline label a whole number.
        return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * step).find((v) => v >= peak && v % 2 === 0) || 10 * step;
      };
      state.segmentPct = (d, family) => d && d[family] ? (d[family] / state.chartMax()) * 100 : 0;
      state.familyTotal = (family) => (state.summary?.series || []).reduce((n, d) => n + d[family], 0);
      state.bucketLabel = (d) => {
        if (!d) return "";
        const date = new Date(d.date);
        const opts = { timeZone: "UTC", day: "numeric", month: "short" };
        if (state.summary?.bucket === "month") return date.toLocaleDateString(undefined, { timeZone: "UTC", month: "short", year: "numeric" });
        if (state.period === "12m" || state.period === "all" || date.getUTCFullYear() !== new Date().getUTCFullYear()) opts.year = "numeric";
        return (state.summary?.bucket === "week" ? "Week of " : "") + date.toLocaleDateString(undefined, opts);
      };
      state.bucketTip = (d) => {
        const total = state.bucketTotal(d);
        if (!total) return state.bucketLabel(d) + ": no sales";
        const parts = BILLING_FAMILIES.filter((f) => d[f.id]).map((f) => d[f.id] + " " + f.label.toLowerCase());
        return state.bucketLabel(d) + ": " + total + (total === 1 ? " sale" : " sales") + " (" + parts.join(", ") + ")";
      };
      state.bucketName = () => ({ day: "day", week: "week", month: "month" })[state.summary?.bucket] || "day";
      state.seriesSales = () => (state.summary?.series || []).reduce((n, d) => n + state.bucketTotal(d), 0);

      state.plansWithActivity = () => (state.summary?.plans || []).filter((p) => p.active || p.allTimeSales || p.sales);
      state.planTotals = () => {
        const sum = (key) => (state.summary?.plans || []).reduce((n, p) => n + (p[key] || 0), 0);
        return { active: sum("active"), sales: sum("sales"), allTimeSales: sum("allTimeSales") };
      };

      state.webhookState = () => {
        const w = state.summary?.webhooks;
        if (!w) return "ok";
        if (w.failed || w.reconciliationFailed) return "bad";
        if (w.oldestPendingSeconds > 900 || w.unreviewedRevocations) return "warn";
        return "ok";
      };
      state.age = (seconds) => seconds ? duration(seconds * 1000) : "—";

      let summaryRequest = 0;
      state.loadSummary = () => {
        const request = ++summaryRequest;
        state.summaryLoading = true;
        state.summaryError = null;
        http.get("/api/admin/billing/summary", { params: { period: state.period } }).then((res) => {
          if (request !== summaryRequest) return;
          state.summaryLoading = false;
          const data = res.data;
          if (!data || !data.subscriptions || !data.sales || !Array.isArray(data.plans)) { state.summaryError = "The billing summary had an unexpected format."; return; }
          state.summary = data;
        }, (err) => {
          if (request !== summaryRequest) return;
          state.summaryLoading = false;
          state.summaryError = (err && err.data && err.data.error) || "Could not load billing figures.";
        });
      };
      state.setPeriod = (id) => {
        if (state.period === id) return;
        state.period = id;
        try { localStorage.setItem("admin.billing.period", id); } catch (e) { /* private mode */ }
        state.loadSummary();
      };

      // -------- grant list --------
      state.grants = [];
      state.total = -1;
      state.totalPage = 0;
      state.stateCounts = {};
      state.statuses = [];
      state.grantsError = null;
      state.filtersOpen = false;
      state.query = { page: 1, limit: 25, search: "", plan: "", status: "", state: "", sort: "purchasedAt", direction: "desc" };
      const urlParams = location.search();
      if (urlParams.search) state.query.search = urlParams.search;
      state.stateView = () => state.query.state || "all";
      state.setStateView = (view) => { state.query.state = view === "all" ? "" : view; state.query.page = 1; };
      state.stateCount = (view) => view === "all"
        ? ["active", "expired", "revoked"].reduce((n, k) => n + (state.stateCounts[k] || 0), 0)
        : state.stateCounts[view] || 0;
      state.sortBy = (field) => {
        if (state.query.sort === field) state.query.direction = state.query.direction === "asc" ? "desc" : "asc";
        else { state.query.sort = field; state.query.direction = "desc"; }
        state.query.page = 1;
      };
      state.sortIcon = (field) => state.query.sort === field ? (state.query.direction === "asc" ? "fa-arrow-up" : "fa-arrow-down") : "";
      state.chips = [];
      const recomputeChips = () => {
        const out = [];
        if (state.query.plan) out.push({ key: "plan", label: "Plan", value: state.planName(state.query.plan) });
        if (state.query.status) out.push({ key: "status", label: "Stripe status", value: state.query.status.replace(/_/g, " ") });
        state.chips = out;
      };
      state.clearFilter = (key) => { state.query[key] = ""; state.query.page = 1; };
      state.filterPlan = (planId) => {
        Object.assign(state.query, { plan: planId, page: 1 });
        const list = document.getElementById("bl-grants");
        if (list && list.scrollIntoView) list.scrollIntoView({ behavior: "smooth", block: "start" });
      };
      state.clearFilters = () => Object.assign(state.query, { search: "", plan: "", status: "", state: "", page: 1 });
      state.hasFilters = () => !!(state.query.search || state.query.plan || state.query.status || state.query.state);
      state.statusText = (g) => (g.status || "unknown").replace(/_/g, " ");
      state.revocationText = (reason) => reason === "dispute" ? "Disputed" : reason === "full_refund" ? "Refunded" : "Revoked";
      state.scopeHref = (scope) => scope?.kind === "repo" ? "/admin/repositories?search=" + encodeURIComponent(scope.id)
        : scope?.kind === "conference" ? "/conference/" + encodeURIComponent(scope.id) : null;

      let grantsRequest = 0;
      function getGrants() {
        const request = ++grantsRequest;
        state.grantsError = null;
        const params = Object.fromEntries(Object.entries(state.query).filter(([, v]) => v !== "" && v != null));
        http.get("/api/admin/billing/grants", { params }).then((res) => {
          if (request !== grantsRequest) return;
          state.total = res.data?.total ?? 0;
          state.totalPage = Math.ceil(state.total / state.query.limit);
          state.grants = res.data?.results || [];
          state.stateCounts = res.data.stateCounts || {};
          state.statuses = res.data.statuses || [];
        }, (err) => {
          if (request !== grantsRequest) return;
          state.grantsError = (err && err.data && err.data.error) || "Could not load subscriptions and purchases.";
        });
      }
      state.reloadGrants = getGrants;

      state.loadSummary();
      getGrants();
      recomputeChips();
      let timeClear = null;
      let lastFilters = JSON.stringify({ ...state.query, page: 0 });
      state.watch("query", () => {
        // A filter change returns to page 1 before fetching.
        const filters = JSON.stringify({ ...state.query, page: 0 });
        if (filters !== lastFilters && state.query.page !== 1) { lastFilters = filters; state.query.page = 1; return; }
        lastFilters = filters;
        timers.timeout.cancel(timeClear);
        timeClear = timers.timeout(getGrants, 300);
        recomputeChips();
      }, true);
    };

export const emailsAdminController = function (state, http, location) {
  if (state.user == null) { location.url("/"); return; }
  state.Math = Math;
  const browser = typeof window !== "undefined" ? window : null;
  const query = browser ? new URLSearchParams(browser.location.search) : null;
  const periods = ["7d", "30d", "90d", "all"];
  const statuses = ["accepted", "rejected", "unknown", "sending"];
  state.emailRows = [];
  state.emailState = statuses.includes(query?.get("state")) ? query.get("state") : "";
  state.emailKind = ["repository-expiration", "owner-access"].includes(query?.get("kind")) ? query.get("kind") : "";
  state.emailPeriod = periods.includes(query?.get("period")) ? query.get("period") : "7d";
  state.emailSearch = query?.get("search") || "";
  let appliedSearch = state.emailSearch.trim();
  state.emailLoading = false;
  state.emailError = "";
  state.emailAnnouncement = "";
  state.emailNextCursor = null;
  state.emailSummary = null;
  state.emailSummaryError = "";
  state.emailSummaryLoading = false;
  state.emailUpdated = null;
  state.emailPage = 1;
  state.selectedEmailId = null;
  state.emailCopyMessage = "";
  state.emailCopiedValue = null;
  state.emailTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  state.emailStatusLabel = (value) => ({ sending: "Pending", accepted: "Accepted", rejected: "Rejected", unknown: "Unknown" }[value] || value);
  state.emailKindLabel = (value) => ({ "repository-expiration": "Repository expiration", "owner-access": "GitHub access" }[value] || value);
  state.emailTime = (value) => value ? new Date(value).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }) : "Not recorded";
  state.emailShortTime = (value) => {
    if (!value) return "Not recorded";
    const date = new Date(value);
    return date.toLocaleString(undefined, { ...(state.emailPeriod === "all" || date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}), month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  state.emailExplanation = (row) => {
    if (row.state === "accepted") return "The provider accepted this request. Inbox delivery is not confirmed.";
    if (row.state === "sending") return "The attempt was recorded, but no final outcome has been recorded. Check the provider before sending again.";
    if (row.state === "unknown") return "The provider outcome could not be confirmed. Check the provider before sending again to avoid duplicates.";
    const reasons = { 400: "The provider rejected the request as invalid.", 401: "The provider rejected authentication.", 403: "The provider denied this request.", 404: "The provider could not find the requested endpoint or resource.", 422: "The provider could not process the request.", 429: "The provider rejected the request because of rate limiting." };
    return reasons[row.httpStatus] || (row.httpStatus >= 500 ? "The provider reported a server error." : "The provider rejected this request.");
  };
  state.toggleEmail = (row) => { state.selectedEmailId = state.selectedEmailId === row._id ? null : row._id; state.emailCopyMessage = ""; state.emailCopiedValue = null; };
  let disposed = false, generation = 0, summaryGeneration = 0, lastFilters = "", lastSummaryFilters = "", failedMore = false, pendingPage = null;
  state.copyEmail = async (value) => {
    state.emailCopiedValue = null;
    try {
      if (!browser?.navigator?.clipboard) throw new Error("Clipboard unavailable");
      await browser.navigator.clipboard.writeText(String(value));
      if (!disposed) { state.emailCopyMessage = "Copied."; state.emailCopiedValue = String(value); }
    } catch { if (!disposed) state.emailCopyMessage = "Could not copy. Select and copy the text manually."; }
  };
  const params = () => ({ period: state.emailPeriod, search: appliedSearch || undefined, kind: state.emailKind || undefined });
  const persist = () => {
    if (!browser) return;
    try {
      const url = new URL(browser.location.href);
      for (const [key, value] of Object.entries({ ...params(), state: state.emailState })) {
        if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
      }
      browser.history.replaceState(null, "", url.pathname + url.search + url.hash);
    } catch { /* History may be unavailable in embedded browsers. */ }
  };
  state.hasEmailFilters = () => !!(state.emailState || state.emailKind || appliedSearch || state.emailPeriod !== "7d");
  state.emailVisibleRows = () => state.emailRows.slice((state.emailPage - 1) * 25, state.emailPage * 25);
  state.emailTotal = () => state.emailSummary ? (state.emailState ? state.emailSummary.counts[state.emailState] : state.emailSummary.total) : null;
  state.emailPageCount = () => state.emailTotal() == null ? null : Math.max(1, Math.ceil(state.emailTotal() / 25));
  state.emailDayTotal = (day) => statuses.reduce((sum, key) => sum + (Number(day[key]) || 0), 0);
  state.emailChartTotal = () => (state.emailSummary?.series || []).reduce((total, day) => total + state.emailDayTotal(day), 0);
  state.jumpToEmailHistory = () => { const heading = browser?.document?.querySelector("#email-history-title"); if (heading) { heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: "start" }); } };
  state.emailChartMax = () => Math.max(1, ...(state.emailSummary?.series || []).map(state.emailDayTotal));
  state.emailDayLabel = (day) => {
    const value = typeof day === "string" ? day : day?.date;
    if (!value) return "";
    const date = new Date(value + "T12:00:00Z");
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  };
  const changePage = (page) => {
    state.emailPage = page; state.selectedEmailId = null; pendingPage = null;
    const start = (page - 1) * 25 + 1, end = Math.min(page * 25, state.emailRows.length);
    state.emailAnnouncement = `Page ${page}. Showing attempts ${start} to ${end}.`;
    const heading = browser?.document?.querySelector("#email-history-title");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({ block: "start", behavior: "auto" });
    }
  };
  state.loadEmailSummary = async () => {
    const filter = JSON.stringify(params());
    if (filter !== lastSummaryFilters) state.emailSummary = null;
    lastSummaryFilters = filter;
    const current = ++summaryGeneration;
    state.emailSummaryLoading = true; state.emailSummaryError = "";
    try {
      const response = await http.get("/api/admin/emails/summary", { params: params() });
      if (current === summaryGeneration) state.emailSummary = response.data;
    } catch {
      if (current === summaryGeneration) state.emailSummaryError = state.emailSummary ? "Could not refresh the summary. Previously loaded totals are still shown." : "Email summary is unavailable.";
    } finally { if (current === summaryGeneration) state.emailSummaryLoading = false; }
  };
  state.retryEmails = () => state.loadEmails(failedMore);
  state.loadEmails = async (more = false) => {
    const filters = JSON.stringify([state.emailState, state.emailKind, state.emailPeriod, appliedSearch]);
    const changed = filters !== lastFilters;
    lastFilters = filters;
    if (changed) more = false;
    if (more && (state.emailLoading || !state.emailNextCursor)) return;
    const current = ++generation;
    state.emailLoading = true; state.emailError = "";
    state.emailAnnouncement = more ? "Loading older emails." : "Loading email history.";
    if (changed) { state.emailRows = []; state.emailNextCursor = null; state.emailPage = 1; state.selectedEmailId = null; pendingPage = null; }
    if (!more) pendingPage = null;
    persist();
    try {
      const response = await http.get("/api/admin/emails", { params: { ...params(), state: state.emailState || undefined, before: more ? state.emailNextCursor : undefined } });
      if (current !== generation) return;
      state.emailRows = more ? state.emailRows.concat(response.data.entries) : response.data.entries;
      state.emailNextCursor = response.data.nextCursor;
      if (!more) state.emailPage = 1;
      state.emailUpdated = new Date().toISOString();
      state.emailAnnouncement = `Email history loaded. ${state.emailRows.length} attempts loaded.`;
      if (more && pendingPage && state.emailRows.length > (pendingPage - 1) * 25) changePage(pendingPage);
      return true;
    } catch {
      if (current === generation) {
        failedMore = more;
        state.emailError = more ? "Could not load older emails. Your loaded history is still shown."
          : state.emailRows.length ? "Could not refresh email history. Previously loaded results are still shown." : "Could not load email history.";
        state.emailAnnouncement = "";
      }
    } finally { if (current === generation) state.emailLoading = false; }
  };
  state.emailPreviousPage = () => { if (!state.emailLoading && state.emailPage > 1) changePage(state.emailPage - 1); };
  state.emailNextPage = async () => {
    if (state.emailLoading) return;
    const target = state.emailPage + 1;
    const filter = lastFilters;
    if (state.emailRows.length <= (target - 1) * 25 && state.emailNextCursor) {
      pendingPage = target;
      await state.loadEmails(true);
    }
    if (!disposed && filter === lastFilters && state.emailPage !== target && state.emailRows.length > (target - 1) * 25) changePage(target);
  };
  state.refreshEmails = () => Promise.all([state.loadEmails(), state.loadEmailSummary()]);
  state.applyEmailFilters = () => { appliedSearch = state.emailSearch.trim(); return state.refreshEmails(); };
  state.setEmailStatus = (value) => { state.emailState = statuses.includes(value) ? value : ""; return state.loadEmails(); };
  state.clearEmailFilters = () => { state.emailState = ""; state.emailKind = ""; state.emailSearch = ""; state.emailPeriod = "7d"; return state.applyEmailFilters(); };
  let navTimer;
  if (browser?.setTimeout) navTimer = browser.setTimeout(() => {
    const nav = browser.document?.querySelector(".emails-page .admin-nav");
    const active = nav?.querySelector('[aria-current="page"]');
    if (nav && active) nav.scrollLeft = Math.max(0, active.offsetLeft - nav.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2);
  }, 0);
  state.on("dispose", () => { disposed = true; generation++; summaryGeneration++; if (navTimer != null) browser.clearTimeout(navTimer); });
  state.refreshEmails();
};
