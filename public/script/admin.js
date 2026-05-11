angular
  .module("admin", [])
  .controller("repositoriesAdminController", [
    "$scope",
    "$http",
    "$location",
    function ($scope, $http, $location) {
      $scope.Math = Math;
      $scope.$watch("user.status", () => {
        if ($scope.user == null) {
          $location.url("/");
        }
      });
      if ($scope.user == null) {
        $location.url("/");
      }

      $scope.repositories = [];
      $scope.total = -1;
      $scope.totalPage = 0;
      $scope.statusCounts = [];
      $scope.totalSize = 0;
      $scope.selected = {};
      $scope.allSelected = false;

      // Slash-to-focus the search input
      const searchKeyHandler = (e) => {
        if (e.key === "/" && !["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName)) {
          e.preventDefault();
          const el = document.querySelector('.admin-filter-toolbar input[type="search"]');
          el && el.focus();
        }
      };
      document.addEventListener("keydown", searchKeyHandler);
      $scope.$on("$destroy", () => document.removeEventListener("keydown", searchKeyHandler));

      $scope.clearFilter = (key) => {
        if (key === "dateRange") { $scope.query.dateFrom = ""; $scope.query.dateTo = ""; }
        else $scope.query[key] = "";
        $scope.query.page = 1;
      };
      $scope.chips = [];
      const recomputeChips = () => {
        const out = [];
        if ($scope.query.owner) out.push({ key: "owner", label: "Owner", value: $scope.query.owner });
        if ($scope.query.conference) out.push({ key: "conference", label: "Conference", value: $scope.query.conference });
        $scope.chips = out;
      };

      $scope.showStatusMessage = (repo) => {
        const msg = repo.statusMessage || "(no message)";
        window.prompt(`Status message for ${repo.repoId} (${repo.status}):`, msg);
      };

      $scope.fetchGithubInfo = (repo) => {
        const w = window.open("", "_blank");
        if (w) w.document.write("<pre>Loading GitHub info for " + repo.repoId + "...</pre>");
        $http.get("/api/admin/repos/" + repo.repoId + "/github").then(
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

      $scope.statusCountFor = (s) => {
        const row = ($scope.statusCounts || []).find((c) => c._id === s);
        return row ? row.count : 0;
      };

      $scope.statusStorageFor = (s) => {
        const row = ($scope.statusCounts || []).find((c) => c._id === s);
        return row ? row.storage : 0;
      };

      $scope.isErrorsOnly = () =>
        $scope.query &&
        $scope.query.error && !$scope.query.ready && !$scope.query.preparing &&
        !$scope.query.expired && !$scope.query.removed;

      $scope.toggleErrorsOnly = () => {
        if ($scope.isErrorsOnly()) {
          Object.assign($scope.query, { ready: false, preparing: true, expired: false, removed: false, error: true });
        } else {
          Object.assign($scope.query, { ready: false, preparing: false, expired: false, removed: false, error: true });
        }
        $scope.query.page = 1;
      };

      $scope.toggleSortDirection = () => {
        $scope.query.direction = $scope.query.direction === "asc" ? "desc" : "asc";
      };
      $scope.sortBy = (field) => {
        if ($scope.query.sort === field) {
          $scope.query.direction = $scope.query.direction === "asc" ? "desc" : "asc";
        } else {
          $scope.query.sort = field;
          $scope.query.direction = "desc";
        }
        $scope.query.page = 1;
      };
      $scope.sortIcon = (field) =>
        $scope.query.sort === field
          ? ($scope.query.direction === "asc" ? "fa-arrow-up" : "fa-arrow-down")
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
        ready: false,
        expired: false,
        removed: false,
        error: true,
        preparing: true,
      };
      const savedReposAdminPrefs = loadFilterPrefs(reposAdminPrefsKey) || {};
      $scope.query = Object.assign({}, reposAdminDefaults, savedReposAdminPrefs, {
        page: 1,
        search: "",
      });

      // pre-fill filters from URL ?owner= / ?conference= / ?search=
      const urlParams = $location.search();
      if (urlParams.owner) $scope.query.owner = urlParams.owner;
      if (urlParams.conference) $scope.query.conference = urlParams.conference;
      if (urlParams.search) $scope.query.search = urlParams.search;

      // -------- presets --------
      const presetsKey = "admin.repos.presets";
      $scope.presets = JSON.parse(localStorage.getItem(presetsKey) || "[]");
      $scope.savePreset = () => {
        const name = window.prompt("Preset name:");
        if (!name) return;
        const snapshot = Object.assign({}, $scope.query);
        delete snapshot.page;
        $scope.presets = ($scope.presets || []).filter((p) => p.name !== name);
        $scope.presets.push({ name, query: snapshot });
        localStorage.setItem(presetsKey, JSON.stringify($scope.presets));
      };
      $scope.applyPreset = (p) => {
        Object.assign($scope.query, p.query, { page: 1 });
      };
      $scope.deletePreset = (p) => {
        $scope.presets = ($scope.presets || []).filter((x) => x.name !== p.name);
        localStorage.setItem(presetsKey, JSON.stringify($scope.presets));
      };

      // -------- selection / bulk --------
      $scope.selectAllOnPage = () => {
        $scope.allSelected = !$scope.allSelected;
        $scope.repositories.forEach((r) => {
          $scope.selected[r.repoId] = $scope.allSelected;
        });
      };
      $scope.selectedCount = () =>
        Object.values($scope.selected || {}).filter(Boolean).length;
      $scope.selectedRepos = () =>
        $scope.repositories.filter((r) => $scope.selected[r.repoId]);

      $scope.bulkRefresh = () => {
        const repos = $scope.selectedRepos();
        if (!repos.length) return;
        if (!confirm(`Force refresh ${repos.length} repositories?`)) return;
        repos.forEach((r) => $scope.updateRepository(r));
      };
      $scope.bulkRemoveCache = () => {
        const repos = $scope.selectedRepos();
        if (!repos.length) return;
        if (!confirm(`Purge cache for ${repos.length} repositories?`)) return;
        repos.forEach((r) => $scope.removeCache(r));
      };
      $scope.clearSelection = () => {
        $scope.selected = {};
        $scope.allSelected = false;
      };

      // -------- export --------
      $scope.exportCsv = () => {
        const params = new URLSearchParams(
          Object.entries($scope.query).filter(([, v]) => v !== "" && v !== false && v != null)
        );
        params.set("format", "csv");
        params.set("limit", "10000");
        window.open("/api/admin/repos?" + params.toString(), "_blank");
      };

      $scope.removeCache = (repo) => {
        if (!confirm("Remove cached files for " + repo.repoId + "?")) return;
        $http.delete("/api/admin/repos/" + repo.repoId).then(
          () => getRepositories(),
          (err) => console.error(err)
        );
      };

      $scope.removeRepository = (repo) => {
        if (!confirm("Remove repository " + repo.repoId + "?")) return;
        $http.delete("/api/repo/" + repo.repoId + "/").then(
          () => getRepositories(),
          (err) => console.error(err)
        );
      };

      $scope.updateRepository = (repo) => {
        const toast = {
          title: `Refreshing ${repo.repoId}...`,
          date: new Date(),
          body: `The repository ${repo.repoId} is going to be refreshed.`,
        };
        $scope.toasts.push(toast);

        $http.post(`/api/repo/${repo.repoId}/refresh`).then(
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

      $scope.fetchError = null;
      function getRepositories() {
        $scope.fetchError = null;
        $http.get("/api/admin/repos", { params: $scope.query }).then(
          (res) => {
            $scope.total = res.data.total;
            $scope.totalPage = Math.ceil(res.data.total / $scope.query.limit);
            $scope.repositories = res.data.results;
            $scope.statusCounts = res.data.statusCounts || [];
            $scope.totalSize = res.data.totalSize || 0;
            $scope.allSelected = false;
          },
          (err) => {
            $scope.fetchError = (err && err.data && err.data.error) || "Failed to load repositories";
            console.error(err);
          }
        );
      }
      getRepositories();

      let timeClear = null;
      $scope.$watch(
        "query",
        () => {
          clearTimeout(timeClear);
          timeClear = setTimeout(getRepositories, 500);
          const { page, search, ...persisted } = $scope.query;
          saveFilterPrefs(reposAdminPrefsKey, persisted);
          recomputeChips();
        },
        true
      );
      recomputeChips();
    },
  ])
  .controller("usersAdminController", [
    "$scope",
    "$http",
    "$location",
    function ($scope, $http, $location) {
      $scope.Math = Math;
      $scope.$watch("user.status", () => {
        if ($scope.user == null) {
          $location.url("/");
        }
      });
      if ($scope.user == null) {
        $location.url("/");
      }

      $scope.users = [];
      $scope.total = -1;
      $scope.totalPage = 0;
      $scope.statusCounts = [];
      $scope.selected = {};
      $scope.allSelected = false;

      const searchKeyHandler = (e) => {
        if (e.key === "/" && !["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName)) {
          e.preventDefault();
          const el = document.querySelector('.admin-filter-toolbar input[type="search"]');
          el && el.focus();
        }
      };
      document.addEventListener("keydown", searchKeyHandler);
      $scope.$on("$destroy", () => document.removeEventListener("keydown", searchKeyHandler));

      $scope.clearFilter = (key) => {
        if (key === "dateRange") { $scope.query.dateFrom = ""; $scope.query.dateTo = ""; }
        else $scope.query[key] = "";
        $scope.query.page = 1;
      };
      $scope.chips = [];
      const recomputeChipsUsers = () => {
        const out = [];
        if ($scope.query.role) out.push({ key: "role", label: "Role", value: $scope.query.role });
        $scope.chips = out;
      };

      $scope.statusCountFor = (s) => {
        const row = ($scope.statusCounts || []).find((c) => c._id === s);
        return row ? row.count : 0;
      };

      $scope.toggleSortDirection = () => {
        $scope.query.direction = $scope.query.direction === "asc" ? "desc" : "asc";
      };
      $scope.sortBy = (field) => {
        if ($scope.query.sort === field) {
          $scope.query.direction = $scope.query.direction === "asc" ? "desc" : "asc";
        } else {
          $scope.query.sort = field;
          $scope.query.direction = "desc";
        }
        $scope.query.page = 1;
      };
      $scope.sortIcon = (field) =>
        $scope.query.sort === field
          ? ($scope.query.direction === "asc" ? "fa-arrow-up" : "fa-arrow-down")
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
      $scope.query = Object.assign({}, usersAdminDefaults, savedUsersAdminPrefs, {
        page: 1,
        search: "",
      });

      $scope.selectAllOnPage = () => {
        $scope.allSelected = !$scope.allSelected;
        $scope.users.forEach((u) => {
          $scope.selected[u.username] = $scope.allSelected;
        });
      };
      $scope.selectedCount = () =>
        Object.values($scope.selected || {}).filter(Boolean).length;
      $scope.selectedUsers = () =>
        $scope.users.filter((u) => $scope.selected[u.username]);

      $scope.banUser = (u) => {
        if (!confirm(`Ban user ${u.username}?`)) return;
        $http
          .post(`/api/admin/users/${u.username}/ban`)
          .then(getUsers, (err) => console.error(err));
      };
      $scope.activateUser = (u) => {
        $http
          .post(`/api/admin/users/${u.username}/activate`)
          .then(getUsers, (err) => console.error(err));
      };
      $scope.bulkBan = () => {
        const users = $scope.selectedUsers();
        if (!users.length) return;
        if (!confirm(`Ban ${users.length} users?`)) return;
        users.forEach((u) => $scope.banUser(u));
      };

      $scope.exportCsv = () => {
        const params = new URLSearchParams(
          Object.entries($scope.query).filter(([, v]) => v !== "" && v !== false && v != null)
        );
        params.set("format", "csv");
        params.set("limit", "10000");
        window.open("/api/admin/users?" + params.toString(), "_blank");
      };

      $scope.fetchError = null;
      function getUsers() {
        $scope.fetchError = null;
        $http.get("/api/admin/users", { params: $scope.query }).then(
          (res) => {
            $scope.total = res.data.total;
            $scope.totalPage = Math.ceil(res.data.total / $scope.query.limit);
            $scope.users = res.data.results;
            $scope.statusCounts = res.data.statusCounts || [];
            $scope.allSelected = false;
            $scope.$apply();
          },
          (err) => {
            $scope.fetchError = (err && err.data && err.data.error) || "Failed to load users";
            console.error(err);
          }
        );
      }
      getUsers();

      let timeClear = null;
      $scope.$watch(
        "query",
        () => {
          clearTimeout(timeClear);
          timeClear = setTimeout(getUsers, 500);
          const { page, search, ...persisted } = $scope.query;
          saveFilterPrefs(usersAdminPrefsKey, persisted);
          recomputeChipsUsers();
        },
        true
      );
      recomputeChipsUsers();
    },
  ])
  .controller("userAdminController", [
    "$scope",
    "$http",
    "$location",
    "$routeParams",
    function ($scope, $http, $location, $routeParams) {
      $scope.$watch("user.status", () => {
        if ($scope.user == null) {
          $location.url("/");
        }
      });
      if ($scope.user == null) {
        $location.url("/");
      }

      $scope.userInfo;
      $scope.repositories = [];
      $scope.search = "";
      $scope.selected = {};
      $scope.allSelected = false;

      const adminUserPrefsKey = "admin.user.filterPrefs";
      const adminUserDefaults = {
        filters: { status: { ready: true, expired: true, removed: true, error: true, preparing: true } },
        sort: "anonymizeDate",
        direction: "desc",
      };
      const savedAdminUserPrefs = loadFilterPrefs(adminUserPrefsKey) || {};
      $scope.filters = {
        status: Object.assign(
          {},
          adminUserDefaults.filters.status,
          (savedAdminUserPrefs.filters && savedAdminUserPrefs.filters.status) || {}
        ),
      };
      $scope.query = {
        sort: savedAdminUserPrefs.sort || adminUserDefaults.sort,
        direction: savedAdminUserPrefs.direction || adminUserDefaults.direction,
      };
      $scope.orderBy = ($scope.query.direction === "asc" ? "" : "-") + $scope.query.sort;

      $scope.sortBy = (field) => {
        if ($scope.query.sort === field) {
          $scope.query.direction = $scope.query.direction === "asc" ? "desc" : "asc";
        } else {
          $scope.query.sort = field;
          $scope.query.direction = "desc";
        }
        $scope.orderBy = ($scope.query.direction === "asc" ? "" : "-") + $scope.query.sort;
      };
      $scope.sortIcon = (field) =>
        $scope.query.sort === field
          ? ($scope.query.direction === "asc" ? "fa-arrow-up" : "fa-arrow-down")
          : "";

      $scope.$watch("query", () => {
        saveFilterPrefs(adminUserPrefsKey, {
          filters: $scope.filters,
          sort: $scope.query.sort,
          direction: $scope.query.direction,
        });
      }, true);
      $scope.$watch(
        "filters",
        () => {
          saveFilterPrefs(adminUserPrefsKey, {
            filters: $scope.filters,
            sort: $scope.query.sort,
            direction: $scope.query.direction,
          });
        },
        true
      );

      $scope.statusCountFor = (s) => {
        return ($scope.repositories || []).filter((r) => r.status === s).length;
      };

      $scope.repoFiler = (repo) => {
        if ($scope.filters.status[repo.status] == false) return false;

        if ($scope.search.trim().length == 0) return true;

        if (repo.source.fullName.indexOf($scope.search) > -1) return true;
        if (repo.repoId.indexOf($scope.search) > -1) return true;
        if (repo.statusMessage && repo.statusMessage.indexOf($scope.search) > -1) return true;
        if (repo.conference && repo.conference.indexOf($scope.search) > -1) return true;

        return false;
      };

      // -------- selection / bulk --------
      $scope.selectAllOnPage = () => {
        $scope.allSelected = !$scope.allSelected;
        ($scope.filteredRepositories || $scope.repositories).forEach((r) => {
          $scope.selected[r.repoId] = $scope.allSelected;
        });
      };
      $scope.selectedCount = () =>
        Object.values($scope.selected || {}).filter(Boolean).length;
      $scope.selectedRepos = () =>
        $scope.repositories.filter((r) => $scope.selected[r.repoId]);
      $scope.bulkRefresh = () => {
        const repos = $scope.selectedRepos();
        if (!repos.length) return;
        if (!confirm(`Force refresh ${repos.length} repositories?`)) return;
        repos.forEach((r) => $scope.updateRepository(r));
      };
      $scope.bulkRemoveCache = () => {
        const repos = $scope.selectedRepos();
        if (!repos.length) return;
        if (!confirm(`Purge cache for ${repos.length} repositories?`)) return;
        repos.forEach((r) => $scope.removeCache(r));
      };
      $scope.clearSelection = () => {
        $scope.selected = {};
        $scope.allSelected = false;
      };

      // -------- export --------
      $scope.exportCsv = () => {
        const filtered = ($scope.filteredRepositories || $scope.repositories);
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
        a.download = $routeParams.username + "-repositories.csv";
        a.click();
      };

      $scope.showStatusMessage = (repo) => {
        const msg = repo.statusMessage || "(no message)";
        window.prompt(`Status message for ${repo.repoId} (${repo.status}):`, msg);
      };

      $scope.fetchGithubInfo = (repo) => {
        const w = window.open("", "_blank");
        if (w) w.document.write("<pre>Loading GitHub info for " + repo.repoId + "...</pre>");
        $http.get("/api/admin/repos/" + repo.repoId + "/github").then(
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
        $http.get("/api/admin/users/" + username + "/repos", {}).then(
          (res) => {
            $scope.repositories = res.data;
          },
          (err) => {
            console.error(err);
          }
        );
      }
      function getUser(username) {
        $http.get("/api/admin/users/" + username, {}).then(
          (res) => {
            $scope.userInfo = res.data;
          },
          (err) => {
            console.error(err);
          }
        );
      }
      getUser($routeParams.username);
      getUserRepositories($routeParams.username);

      $scope.banUser = () => {
        if (!confirm(`Ban user ${$routeParams.username}?`)) return;
        $http
          .post(`/api/admin/users/${$routeParams.username}/ban`)
          .then(() => getUser($routeParams.username), (err) => console.error(err));
      };
      $scope.activateUser = () => {
        $http
          .post(`/api/admin/users/${$routeParams.username}/activate`)
          .then(() => getUser($routeParams.username), (err) => console.error(err));
      };
      $scope.promoteUser = () => {
        if (!confirm(`Promote ${$routeParams.username} to admin?`)) return;
        $http
          .post(`/api/admin/users/${$routeParams.username}/promote`)
          .then(() => getUser($routeParams.username), (err) => console.error(err));
      };
      $scope.demoteUser = () => {
        if (!confirm(`Remove admin privileges from ${$routeParams.username}?`)) return;
        $http
          .post(`/api/admin/users/${$routeParams.username}/demote`)
          .then(() => getUser($routeParams.username), (err) => console.error(err));
      };

      $scope.tokens = [];
      $scope.tokenForm = { name: "", plaintext: null };

      function loadTokens() {
        $http.get("/api/admin/tokens").then(
          (res) => {
            $scope.tokens = res.data || [];
          },
          (err) => {
            if (err.status !== 401 && err.status !== 403) console.error(err);
          }
        );
      }
      loadTokens();

      $scope.createToken = () => {
        if (!$scope.tokenForm.name) return;
        $http
          .post("/api/admin/tokens", { name: $scope.tokenForm.name })
          .then(
            (res) => {
              $scope.tokenForm.plaintext = res.data.token;
              $scope.tokenForm.name = "";
              loadTokens();
            },
            (err) => console.error(err)
          );
      };

      $scope.revokeToken = (t) => {
        if (!confirm(`Revoke token "${t.name}"?`)) return;
        $http.delete("/api/admin/tokens/" + t.id).then(
          () => loadTokens(),
          (err) => console.error(err)
        );
      };

      $scope.removeCache = (repo) => {
        if (!confirm("Remove cached files for " + repo.repoId + "?")) return;
        $http.delete("/api/admin/repos/" + repo.repoId).then(
          () => getUserRepositories($routeParams.username),
          (err) => console.error(err)
        );
      };

      $scope.removeRepository = (repo) => {
        if (!confirm("Remove repository " + repo.repoId + "?")) return;
        $http.delete("/api/repo/" + repo.repoId + "/").then(
          () => getUserRepositories($routeParams.username),
          (err) => console.error(err)
        );
      };

      $scope.updateRepository = (repo) => {
        const toast = {
          title: `Refreshing ${repo.repoId}...`,
          date: new Date(),
          body: `The repository ${repo.repoId} is going to be refreshed.`,
        };
        $scope.toasts.push(toast);

        $http.post(`/api/repo/${repo.repoId}/refresh`).then(
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

      $scope.getGitHubRepositories = (force) => {
        $http
          .get(`/api/user/${$scope.userInfo.username}/all_repositories`, {
            params: { force: "1" },
          })
          .then((res) => {
            $scope.userInfo.repositories = res.data;
          });
      };

      let timeClear = null;
      $scope.$watch(
        "query",
        () => {
          clearTimeout(timeClear);
          timeClear = setTimeout(() => {
            getUserRepositories($routeParams.username);
          }, 500);
        },
        true
      );
    },
  ])
  .controller("conferencesAdminController", [
    "$scope",
    "$http",
    "$location",
    function ($scope, $http, $location) {
      $scope.Math = Math;
      $scope.$watch("user.status", () => {
        if ($scope.user == null) {
          $location.url("/");
        }
      });
      if ($scope.user == null) {
        $location.url("/");
      }

      $scope.conferences = [];
      $scope.total = -1;
      $scope.totalPage = 0;
      $scope.statusCounts = [];

      const searchKeyHandler = (e) => {
        if (e.key === "/" && !["INPUT","TEXTAREA","SELECT"].includes(document.activeElement?.tagName)) {
          e.preventDefault();
          const el = document.querySelector('.admin-filter-toolbar input[type="search"]');
          el && el.focus();
        }
      };
      document.addEventListener("keydown", searchKeyHandler);
      $scope.$on("$destroy", () => document.removeEventListener("keydown", searchKeyHandler));

      $scope.clearFilter = (key) => {
        if (key === "dateRange") { $scope.query.dateFrom = ""; $scope.query.dateTo = ""; }
        else $scope.query[key] = "";
        $scope.query.page = 1;
      };
      $scope.chips = [];
      const recomputeChipsConf = () => {
        const out = [];
        if ($scope.query.dateFrom || $scope.query.dateTo) out.push({ key: "dateRange", label: "Date", value: ($scope.query.dateFrom || "…") + " – " + ($scope.query.dateTo || "…") });
        $scope.chips = out;
      };

      $scope.statusCountFor = (s) => {
        const row = ($scope.statusCounts || []).find((c) => c._id === s);
        return row ? row.count : 0;
      };

      $scope.toggleSortDirection = () => {
        $scope.query.direction = $scope.query.direction === "asc" ? "desc" : "asc";
      };
      $scope.sortBy = (field) => {
        if ($scope.query.sort === field) {
          $scope.query.direction = $scope.query.direction === "asc" ? "desc" : "asc";
        } else {
          $scope.query.sort = field;
          $scope.query.direction = "desc";
        }
        $scope.query.page = 1;
      };
      $scope.sortIcon = (field) =>
        $scope.query.sort === field
          ? ($scope.query.direction === "asc" ? "fa-arrow-up" : "fa-arrow-down")
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
        ready: false,
        expired: false,
        removed: false,
        error: true,
        preparing: true,
      };
      const savedConfAdminPrefs = loadFilterPrefs(confAdminPrefsKey) || {};
      $scope.query = Object.assign({}, confAdminDefaults, savedConfAdminPrefs, {
        page: 1,
        search: "",
      });

      // pre-fill filters from URL ?search=
      const urlParams = $location.search();
      if (urlParams.search) $scope.query.search = urlParams.search;

      // -------- presets --------
      const confPresetsKey = "admin.conferences.presets";
      $scope.presets = JSON.parse(localStorage.getItem(confPresetsKey) || "[]");
      $scope.savePreset = () => {
        const name = window.prompt("Preset name:");
        if (!name) return;
        const snapshot = Object.assign({}, $scope.query);
        delete snapshot.page;
        $scope.presets = ($scope.presets || []).filter((p) => p.name !== name);
        $scope.presets.push({ name, query: snapshot });
        localStorage.setItem(confPresetsKey, JSON.stringify($scope.presets));
      };
      $scope.applyPreset = (p) => {
        Object.assign($scope.query, p.query, { page: 1 });
      };
      $scope.deletePreset = (p) => {
        $scope.presets = ($scope.presets || []).filter((x) => x.name !== p.name);
        localStorage.setItem(confPresetsKey, JSON.stringify($scope.presets));
      };

      $scope.removeConference = (conference) => {
        if (!confirm("Remove conference " + conference.conferenceID + "?")) return;
        $http.delete("/api/admin/conferences/" + conference.conferenceID).then(
          () => getConferences(),
          (err) => console.error(err)
        );
      };

      $scope.exportCsv = () => {
        const params = new URLSearchParams(
          Object.entries($scope.query).filter(([, v]) => v !== "" && v !== false && v != null)
        );
        params.set("format", "csv");
        params.set("limit", "10000");
        window.open("/api/admin/conferences?" + params.toString(), "_blank");
      };

      $scope.fetchError = null;
      function getConferences() {
        $scope.fetchError = null;
        $http.get("/api/admin/conferences", { params: $scope.query }).then(
          (res) => {
            $scope.total = res.data.total;
            $scope.totalPage = Math.ceil(res.data.total / $scope.query.limit);
            $scope.conferences = res.data.results;
            $scope.statusCounts = res.data.statusCounts || [];
          },
          (err) => {
            $scope.fetchError = (err && err.data && err.data.error) || "Failed to load conferences";
            console.error(err);
          }
        );
      }
      getConferences();

      let timeClear = null;
      $scope.$watch(
        "query",
        () => {
          clearTimeout(timeClear);
          timeClear = setTimeout(getConferences, 500);
          const { page, search, ...persisted } = $scope.query;
          saveFilterPrefs(confAdminPrefsKey, persisted);
          recomputeChipsConf();
        },
        true
      );
      recomputeChipsConf();
    },
  ])
  .controller("queuesAdminController", [
    "$scope",
    "$http",
    "$location",
    "$interval",
    "$timeout",
    function ($scope, $http, $location, $interval, $timeout) {
      $scope.$watch("user.status", () => {
        if ($scope.user == null) $location.url("/");
      });
      if ($scope.user == null) $location.url("/");

      $scope.queueList = [];
      $scope.jobs = [];
      $scope.selectedQueue = "download";
      $scope.selectedStats = null;
      $scope.range = "1h";
      $scope.allStates = ["active", "waiting", "delayed", "failed", "completed"];
      $scope.stateFilter = { active: true, waiting: true, delayed: true, failed: true, completed: true };
      $scope.query = {
        search: "",
        autoRefresh: true,
      };

      $scope.filteredJobs = () => {
        return ($scope.jobs || []).filter((j) => $scope.stateFilter[j._state]);
      };

      $scope.jobProgressPct = (job) => {
        if (job && job.progress && typeof job.progress === "object" && typeof job.progress.percent === "number") {
          return Math.max(0, Math.min(100, Math.round(job.progress.percent)));
        }
        if (typeof job.progress === "number") {
          return Math.max(0, Math.min(100, Math.round(job.progress)));
        }
        return null;
      };

      $scope.jobDuration = (job) => {
        if (!job.processedOn) return "-";
        const end = job.finishedOn || Date.now();
        const ms = end - job.processedOn;
        if (ms < 1000) return ms + "ms";
        return (ms / 1000).toFixed(1) + "s";
      };

      $scope.metricsPoints = [];

      $scope.selectQueue = (key) => {
        $scope.selectedQueue = key;
        getQueues();
        getMetrics();
      };

      $scope.setRange = (r) => {
        $scope.range = r;
        getMetrics();
      };

      function getQueues() {
        const params = {
          queue: $scope.selectedQueue,
          search: $scope.query.search,
        };
        $http.get("/api/admin/queues", { params }).then(
          (res) => {
            $scope.queueList = res.data.queues || [];
            $scope.jobs = res.data.jobs || [];
            $scope.selectedStats = $scope.queueList.find((q) => q.key === $scope.selectedQueue) || $scope.queueList[0] || null;
          },
          (err) => console.error(err)
        );
      }

      function getMetrics() {
        $http.get("/api/admin/queues/metrics", {
          params: { queue: $scope.selectedQueue, range: $scope.range }
        }).then(
          (res) => {
            $scope.metricsPoints = res.data.points || [];
            $timeout(drawChart, 0);
          },
          (err) => console.error(err)
        );
      }
      getQueues();
      getMetrics();

      const stop = $interval(() => {
        if ($scope.query.autoRefresh) {
          getQueues();
          getMetrics();
        }
      }, 15000);
      $scope.$on("$destroy", () => $interval.cancel(stop));

      $scope.refreshNow = function () { getQueues(); getMetrics(); };

      function apiError(err) {
        const msg = (err && err.data && (err.data.message || err.data.error)) || "Request failed";
        $scope.actionError = msg;
        $timeout(() => { $scope.actionError = null; }, 5000);
        console.error(err);
      }

      $scope.actionError = null;

      $scope.removeJob = (job) => {
        $http.delete(`/api/admin/queue/${$scope.selectedQueue}/${job.id}`).then(getQueues, apiError);
      };

      $scope.retryJob = (job) => {
        $http.post(`/api/admin/queue/${$scope.selectedQueue}/${job.id}`).then(getQueues, apiError);
      };

      $scope.retryFailed = () => {
        if (!confirm(`Retry all failed jobs in ${$scope.selectedQueue}?`)) return;
        $http.post(`/api/admin/queue/${$scope.selectedQueue}/retry-failed`).then(getQueues, (err) => console.error(err));
      };

      $scope.drainSelected = () => {
        if (!confirm(`Drain the ${$scope.selectedQueue} queue?`)) return;
        $http.post(`/api/admin/queue/${$scope.selectedQueue}/drain`).then(getQueues, (err) => console.error(err));
      };

      $scope.togglePause = () => {
        const action = $scope.selectedStats && $scope.selectedStats.paused ? "resume" : "pause";
        $http.post(`/api/admin/queue/${$scope.selectedQueue}/${action}`).then(getQueues, (err) => console.error(err));
      };

      $scope.emptyQueue = () => {
        if (!confirm(`Empty the ${$scope.selectedQueue} queue? This removes ALL jobs.`)) return;
        $http.post(`/api/admin/queue/${$scope.selectedQueue}/empty`).then(getQueues, (err) => console.error(err));
      };

      $scope.pauseAll = () => {
        if (!confirm("Pause all queues?")) return;
        $http.post("/api/admin/queues/pause-all").then(getQueues, (err) => console.error(err));
      };

      let searchClear = null;
      $scope.$watch("query.search", () => {
        clearTimeout(searchClear);
        searchClear = setTimeout(getQueues, 350);
      });
      $scope.expanded = {};
      $scope.toggleJob = (job) => {
        $scope.expanded[job.id] = !$scope.expanded[job.id];
      };

      $scope.humanTime = (ts) => {
        if (!ts) return "";
        const d = new Date(ts);
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
          + " " + d.toLocaleDateString([], { month: "short", day: "numeric" });
      };

      $scope.delayCountdown = (ts) => {
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
        var marginRight = 50;
        var marginBottom = 20;
        var totalW = rect.width - 40;
        var totalH = 180;
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
        var completedColor = isDark ? "#A7B2FF" : "#3B4AD6";
        var completedFill = isDark ? "rgba(167,178,255,0.12)" : "rgba(59,74,214,0.08)";
        var failedColor = isDark ? "#F08A82" : "#B42318";
        var failedFill = isDark ? "rgba(240,138,130,0.08)" : "rgba(180,35,24,0.06)";
        var execColor = isDark ? "#F5C842" : "#B8860B";

        var pts = $scope.metricsPoints || [];
        if (pts.length === 0) {
          ctx.fillStyle = labelColor;
          ctx.font = "12px monospace";
          ctx.textAlign = "center";
          ctx.fillText("No metrics data yet", totalW / 2, totalH / 2);
          chartState = null;
          return;
        }

        // Data is oldest→newest from the API; chart shows newest on the right
        var completedPts = pts.map(function (p) { return p.completed; });
        var failedPts = pts.map(function (p) { return p.failed; });
        var execPts = pts.map(function (p) { return p.avgMs; });
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
        ctx.font = "10px monospace";
        left.ticks.forEach(function (v) {
          var y = toY(v);
          ctx.strokeStyle = gridColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(marginLeft, y);
          ctx.lineTo(totalW - marginRight, y);
          ctx.stroke();
          ctx.fillStyle = labelColor;
          ctx.fillText(v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(v), marginLeft - 6, y);
        });

        // Right Y-axis labels (ms)
        if (execMax > 0) {
          ctx.textAlign = "left";
          right.ticks.forEach(function (v) {
            var y = toYr(v);
            ctx.fillStyle = execColor;
            ctx.fillText(v >= 1000 ? (v / 1000).toFixed(1) + "s" : v + "ms", totalW - marginRight + 6, y);
          });
        }

        // X-axis time labels using actual timestamps
        var now = Date.now();
        var xLabelCount = Math.min(6, maxLen);
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        for (var i = 0; i < xLabelCount; i++) {
          var idx = Math.round((i / (xLabelCount - 1)) * (maxLen - 1));
          var minsAgo = Math.round((now - pts[idx].ts) / 60000);
          var x = toX(idx);
          var lbl;
          if (minsAgo <= 0) lbl = "now";
          else if (minsAgo < 60) lbl = minsAgo + "m";
          else if (minsAgo < 1440) lbl = Math.round(minsAgo / 60) + "h";
          else lbl = Math.round(minsAgo / 1440) + "d";
          ctx.fillStyle = labelColor;
          ctx.fillText(lbl, x, h + 4);
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
          var now = Date.now();
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
            var dur = p.avgMs >= 1000 ? (p.avgMs / 1000).toFixed(1) + "s" : p.avgMs + "ms";
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

      $scope.$watch("metricsPoints", function () {
        $timeout(setupTooltip, 50);
      });
    },
  ])
  .controller("errorsAdminController", [
    "$scope",
    "$http",
    "$location",
    "$interval",
    function ($scope, $http, $location, $interval) {
      $scope.$watch("user.status", () => {
        if ($scope.user == null) {
          $location.url("/");
        }
      });
      if ($scope.user == null) {
        $location.url("/");
      }

      $scope.entries = [];
      $scope.visible = [];
      $scope.available = true;
      $scope.cap = 1000;
      $scope.total = 0;
      $scope.pageSize = 250;
      $scope.expanded = {};
      $scope.detailTab = {};
      $scope.copyHint = "";
      $scope.parsedFilterCount = 0;
      $scope.stats = { last24h: 0, prev24h: 0, delta: 0, severity: { error: 0, warn: 0, info: 0 }, unique: { error: 0, warn: 0, info: 0 }, buckets: [], dropped: 0 };
      $scope.query = {
        search: "",
        bucket: "",
        sort: "recent",
        group: "code",
        autoRefresh: true,
      };

      $scope.relTime = (iso) => {
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
        return new Date(iso).toLocaleDateString();
      };
      $scope.absTime = (iso) => {
        if (!iso) return "";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleString();
      };
      $scope.absTimeShort = (iso) => {
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
        const parsed = parseFilter($scope.query.search || "");
        $scope.parsedFilterCount = parsed.filters.length;
        const bucket = $scope.query.bucket;
        let rows = $scope.entries.filter((e) => {
          if (bucket && e._bucket !== bucket) return false;
          return matchFilter(e, parsed);
        });

        const group = $scope.query.group;
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

        if ($scope.query.sort === "count") {
          rows.sort((a, b) => b.count - a.count || new Date(b.ts) - new Date(a.ts));
        } else {
          rows.sort((a, b) => new Date(b.ts) - new Date(a.ts));
        }
        $scope.visible = rows;
      }

      function loadEntries(append) {
        // On auto-refresh after the user has paginated ("Load older"),
        // request the SAME-sized window from the head so we don't blow away
        // their loaded tail. Newer entries take the top, the oldest visible
        // ones drop off naturally as the redis list rotates.
        const offset = append ? $scope.entries.length : 0;
        const limit = append
          ? $scope.pageSize
          : Math.max($scope.pageSize, $scope.entries.length || $scope.pageSize);
        $http
          .get("/api/admin/errors", { params: { offset, limit } })
          .then(
            (res) => {
              const next = (res.data.entries || []).map(decorate);
              $scope.entries = append ? $scope.entries.concat(next) : next;
              $scope.available = !!res.data.available;
              $scope.cap = res.data.max || $scope.cap;
              $scope.total = res.data.total || $scope.entries.length;
              recompute();
            },
            (err) => console.error(err)
          );
      }
      $scope.loadMore = () => loadEntries(true);
      $scope.canLoadMore = () => $scope.entries.length < $scope.total;
      function loadStats() {
        $http.get("/api/admin/errors/stats").then(
          (res) => {
            const s = res.data || {};
            const delta = s.prev24h ? Math.round(((s.last24h - s.prev24h) / s.prev24h) * 100) : 0;
            $scope.stats = {
              last24h: s.last24h || 0,
              prev24h: s.prev24h || 0,
              delta,
              severity: s.severity || { error: 0, warn: 0, info: 0 },
              unique: s.unique || { error: 0, warn: 0, info: 0 },
              buckets: s.buckets || [],
              dropped: s.dropped || 0,
            };
          },
          (err) => console.error(err)
        );
      }
      function load() {
        loadEntries();
        loadStats();
      }

      // For the volume chart: scale tallest bucket-total to a fixed pixel max.
      $scope.barPx = (b, key) => {
        const all = $scope.stats.buckets || [];
        let max = 0;
        for (const x of all) max = Math.max(max, (x.error || 0) + (x.warn || 0) + (x.info || 0));
        if (!max) return 0;
        const total = (b.error || 0) + (b.warn || 0) + (b.info || 0);
        if (!total) return 0;
        const targetTotal = Math.round((total / max) * 60); // 60px max
        const part = b[key] || 0;
        return Math.round((part / total) * targetTotal);
      };
      $scope.bucketTitle = (b) => {
        const t = new Date(b.hour);
        return `${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${b.error || 0} err · ${b.warn || 0} warn · ${b.info || 0} info`;
      };

      $scope.toggle = (row) => {
        $scope.expanded[row._key] = !$scope.expanded[row._key];
      };
      $scope.setBucket = (b) => {
        $scope.query.bucket = b;
      };

      $scope.refreshNow = load;
      $scope.clearAll = () => {
        if (!confirm("Clear all captured errors?")) return;
        $http.delete("/api/admin/errors").then(load, (err) => console.error(err));
      };
      $scope.exportCsv = () => {
        const cols = ["ts", "level", "module", "displayMessage", "_status", "_url", "_repoId"];
        const lines = [cols.join(",")];
        for (const r of $scope.visible) {
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
        $scope.copyHint = `${label} copied`;
        setTimeout(() => { $scope.copyHint = ""; $scope.$apply(); }, 1500);
      }
      $scope.copyJson = (row) => {
        navigator.clipboard.writeText(row._detailJson).then(() => flashCopy("JSON"));
      };
      $scope.copyCurl = (row) => {
        if (!row._url) return;
        const method = row._method || "GET";
        const cmd = `curl -X ${method} '${window.location.origin}${row._url}'`;
        navigator.clipboard.writeText(cmd).then(() => flashCopy("curl"));
      };

      load();
      const stop = $interval(() => {
        if ($scope.query.autoRefresh) load();
      }, 15000);
      $scope.$on("$destroy", () => $interval.cancel(stop));

      $scope.$watch("query.search", recompute);
      $scope.$watch("query.bucket", recompute);
      $scope.$watch("query.sort", recompute);
      $scope.$watch("query.group", recompute);
    },
  ])
  .controller("overviewAdminController", [
    "$scope",
    "$http",
    "$location",
    "$interval",
    function ($scope, $http, $location, $interval) {
      $scope.Math = Math;
      $scope.$watch("user.status", () => {
        if ($scope.user == null) $location.url("/");
      });
      if ($scope.user == null) { $location.url("/"); return; }

      $scope.data = null;
      $scope.loading = true;
      $scope.error = null;

      function humanBytes(b) {
        if (b == null) return "—";
        var units = ["B","KB","MB","GB","TB"];
        var i = 0;
        var v = b;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return v.toFixed(i > 0 ? 1 : 0) + " " + units[i];
      }
      $scope.humanBytes = humanBytes;

      function humanDuration(seconds) {
        if (!seconds) return "—";
        var d = Math.floor(seconds / 86400);
        var h = Math.floor((seconds % 86400) / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        if (d > 0) return d + "d " + (h < 10 ? "0" : "") + h + "h";
        if (h > 0) return h + "h " + (m < 10 ? "0" : "") + m + "m";
        return m + "m";
      }
      $scope.humanDuration = humanDuration;

      function humanNum(n) {
        if (n == null) return "—";
        if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
        if (n >= 1000) return (n / 1000).toFixed(1) + "K";
        return String(n);
      }
      $scope.humanNum = humanNum;

      $scope.queueTotal = function (q) {
        if (!q) return 0;
        return (q.waiting || 0) + (q.active || 0) + (q.delayed || 0) + (q.failed || 0);
      };

      $scope.statusCount = function (status) {
        if (!$scope.data || !$scope.data.repos) return 0;
        var bd = $scope.data.repos.statusBreakdown || [];
        for (var i = 0; i < bd.length; i++) {
          if (bd[i]._id === status) return bd[i].count;
        }
        return 0;
      };

      $scope.barPct = function (status) {
        var total = $scope.data && $scope.data.repos ? $scope.data.repos.total : 0;
        if (!total) return 0;
        var names = [status];
        if (status === "expired") names.push("expiring");
        if (status === "removed") names.push("removing");
        if (status === "preparing") names.push("download");
        var sum = 0;
        names.forEach(function (n) { sum += $scope.statusCount(n); });
        return Math.max(0.4, (sum / total) * 100);
      };

      $scope.errPct = function (key) {
        if (!$scope.data || !$scope.data.errors) return 0;
        var max = Math.max(
          $scope.data.errors.severity.error,
          $scope.data.errors.severity.warn,
          $scope.data.errors.severity.info,
          1
        );
        return ($scope.data.errors.severity[key] / max) * 100;
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

      var historyMaxes = {};
      $scope.historyBarH = function (d, field) {
        if (!d || !historyMaxes[field]) return 0;
        return Math.max(1, Math.round((d[field] / historyMaxes[field]) * 140));
      };
      $scope.historyLabel = function (d) {
        if (!d || !d.date) return "";
        var dt = new Date(d.date);
        return (dt.getUTCMonth() + 1) + "/" + dt.getUTCDate();
      };

      function load() {
        $http.get("/api/admin/overview").then(function (r) {
          r.data.history = computeDailyHistory(r.data.history);
          r.data.daily = {
            today: todayDailyStats(r.data.history),
          };
          $scope.data = r.data;
          $scope.loading = false;
          $scope.error = null;
          historyMaxes = {};
          (r.data.history || []).forEach(function (d) {
            ["dailyPageViews", "dailyRepositories", "dailyUsers", "nbUsers"].forEach(function (k) {
              if (!historyMaxes[k] || d[k] > historyMaxes[k]) historyMaxes[k] = d[k];
            });
          });
        }, function (err) {
          $scope.loading = false;
          $scope.error = (err.data && err.data.error) || "Failed to load overview";
        });
      }

      load();
      var stop = $interval(load, 30000);
      $scope.$on("$destroy", function () { $interval.cancel(stop); });
    },
  ]);
