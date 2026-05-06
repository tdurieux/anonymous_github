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

      // pre-fill owner / conference from URL ?owner= / ?conference=
      const params = new URLSearchParams(window.location.search);
      if (params.get("owner")) $scope.query.owner = params.get("owner");
      if (params.get("conference")) $scope.query.conference = params.get("conference");

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
        $http.delete("/api/admin/repos/" + repo.repoId).then(
          (res) => {
            $scope.$apply();
          },
          (err) => {
            console.error(err);
          }
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

      const adminUserPrefsKey = "admin.user.filterPrefs";
      const adminUserDefaults = {
        filters: { status: { ready: true, expired: true, removed: true, error: true, preparing: true } },
        orderBy: "-anonymizeDate",
      };
      const savedAdminUserPrefs = loadFilterPrefs(adminUserPrefsKey) || {};
      $scope.filters = {
        status: Object.assign(
          {},
          adminUserDefaults.filters.status,
          (savedAdminUserPrefs.filters && savedAdminUserPrefs.filters.status) || {}
        ),
      };
      $scope.orderBy = savedAdminUserPrefs.orderBy || adminUserDefaults.orderBy;

      $scope.$watch("orderBy", () => {
        saveFilterPrefs(adminUserPrefsKey, {
          filters: $scope.filters,
          orderBy: $scope.orderBy,
        });
      });
      $scope.$watch(
        "filters",
        () => {
          saveFilterPrefs(adminUserPrefsKey, {
            filters: $scope.filters,
            orderBy: $scope.orderBy,
          });
        },
        true
      );

      $scope.repoFiler = (repo) => {
        if ($scope.filters.status[repo.status] == false) return false;

        if ($scope.search.trim().length == 0) return true;

        if (repo.source.fullName.indexOf($scope.search) > -1) return true;
        if (repo.repoId.indexOf($scope.search) > -1) return true;

        return false;
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
        $http.delete("/api/admin/repos/" + repo.repoId).then(
          (res) => {
            $scope.$apply();
          },
          (err) => {
            console.error(err);
          }
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
        $scope.chips = [];
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
        status: "",
        dateFrom: "",
        dateTo: "",
      };
      const savedConfAdminPrefs = loadFilterPrefs(confAdminPrefsKey) || {};
      $scope.query = Object.assign({}, confAdminDefaults, savedConfAdminPrefs, {
        page: 1,
        search: "",
      });

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
            $scope.$apply();
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
    function ($scope, $http, $location, $interval) {
      $scope.$watch("user.status", () => {
        if ($scope.user == null) {
          $location.url("/");
        }
      });
      if ($scope.user == null) {
        $location.url("/");
      }

      $scope.downloadJobs = [];
      $scope.removeJobs = [];
      $scope.removeCaches = [];
      $scope.counts = { download: {}, remove: {}, cache: {} };
      $scope.query = {
        search: "",
        state: "",
        autoRefresh: true,
      };

      $scope.jobMatchesState = (job) => {
        if (!$scope.query.state) return true;
        const finished = !!job.finishedOn;
        const failed = (job.stacktrace || []).length > 0 || job.failedReason;
        const map = {
          completed: finished && !failed,
          failed: failed,
          active: job.processedOn && !finished,
          waiting: !job.processedOn,
        };
        return !!map[$scope.query.state];
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

      $scope.bulkRetryFailed = (queue) => {
        if (!confirm(`Retry all failed jobs in the ${queue} queue?`)) return;
        $http.post(`/api/admin/queue/${queue}/retry-failed`).then(getQueues, (err) => console.error(err));
      };
      $scope.bulkDrain = (queue) => {
        if (!confirm(`Drain (clear waiting+delayed) the ${queue} queue?`)) return;
        $http.post(`/api/admin/queue/${queue}/drain`).then(getQueues, (err) => console.error(err));
      };

      function getQueues() {
        $http.get("/api/admin/queues", { params: $scope.query }).then(
          (res) => {
            $scope.downloadJobs = res.data.downloadQueue;
            $scope.removeJobs = res.data.removeQueue;
            $scope.removeCaches = res.data.cacheQueue;
            $scope.counts = res.data.counts || $scope.counts;
          },
          (err) => {
            console.error(err);
          }
        );
      }
      getQueues();

      // auto-refresh every 5 seconds while autoRefresh is on
      const stop = $interval(() => {
        if ($scope.query.autoRefresh) getQueues();
      }, 5000);
      $scope.$on("$destroy", () => $interval.cancel(stop));

      $scope.refreshNow = getQueues;

      $scope.removeJob = function (queue, job) {
        $http
          .delete(`/api/admin/queue/${queue}/${job.id}`, {
            params: $scope.query,
          })
          .then(
            (res) => {
              getQueues();
            },
            (err) => {
              console.error(err);
            }
          );
      };

      $scope.retryJob = function (queue, job) {
        $http
          .post(`/api/admin/queue/${queue}/${job.id}`, {
            params: $scope.query,
          })
          .then(
            (res) => {
              getQueues();
            },
            (err) => {
              console.error(err);
            }
          );
      };

      let searchClear = null;
      $scope.$watch(
        "query.search",
        () => {
          clearTimeout(searchClear);
          searchClear = setTimeout(getQueues, 350);
        }
      );
      $scope.$watch("query.state", getQueues);
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
      $scope.filtered = [];
      $scope.modules = [];
      $scope.available = true;
      $scope.query = {
        search: "",
        module: "",
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

      // Decorate each entry once with derived display fields (chips + json).
      // Returning a fresh array from a template-bound function each digest
      // cycle triggers Angular's $rootScope:infdig — so we precompute on load.
      function statusKind(s) {
        const n = parseInt(s, 10);
        if (!n) return "";
        if (n >= 500) return "err";
        if (n >= 400) return "warn";
        return "ok";
      }
      // snake_case identifier looking like an error key (e.g. "repo_not_found").
      const errorKeyRe = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
      function decorate(e) {
        const chips = [];
        const detail = (e.raw || []).find(
          (a) => a && typeof a === "object" && !Array.isArray(a)
        );
        if (detail) {
          // Prefer the structured error key (e.g. "pull_request_not_found")
          // over the generic logger message ("anonymous error", "http error").
          if (detail.message && errorKeyRe.test(detail.message)) {
            e.displayMessage = detail.message;
            e.displayContext = e.message;
          } else if (detail.code && errorKeyRe.test(String(detail.code))) {
            e.displayMessage = String(detail.code);
            e.displayContext = e.message;
          } else {
            e.displayMessage = e.message;
          }
          if (detail.httpStatus) chips.push({ label: "status", value: detail.httpStatus, kind: statusKind(detail.httpStatus) });
          else if (detail.status) chips.push({ label: "status", value: detail.status, kind: statusKind(detail.status) });
          if (detail.method) chips.push({ label: "method", value: detail.method });
          if (detail.url) chips.push({ label: "url", value: detail.url, mono: true });
          if (detail.repoId) chips.push({ label: "repo", value: detail.repoId, mono: true });
          if (detail.code && detail.code !== detail.message && detail.code !== e.displayMessage) {
            chips.push({ label: "code", value: detail.code });
          }
        } else {
          e.displayMessage = e.message;
        }
        const tail = (e.raw || []).slice(1);
        const detailJson = !tail.length
          ? ""
          : tail.length === 1
            ? JSON.stringify(tail[0], null, 2)
            : JSON.stringify(tail, null, 2);
        e._chips = chips;
        e._detailJson = detailJson;
        return e;
      }

      function applyFilter() {
        const q = ($scope.query.search || "").toLowerCase();
        const mod = $scope.query.module || "";
        $scope.filtered = $scope.entries.filter((e) => {
          if (mod && e.module !== mod) return false;
          if (!q) return true;
          const hay = (
            (e.displayMessage || e.message || "") +
            " " +
            e.module +
            " " +
            JSON.stringify(e.raw || [])
          ).toLowerCase();
          return hay.indexOf(q) > -1;
        });
      }

      function load() {
        $http.get("/api/admin/errors").then(
          (res) => {
            $scope.entries = (res.data.entries || []).map(decorate);
            $scope.available = !!res.data.available;
            const set = new Set();
            $scope.entries.forEach((e) => e.module && set.add(e.module));
            $scope.modules = Array.from(set).sort();
            applyFilter();
          },
          (err) => console.error(err)
        );
      }

      $scope.refreshNow = load;
      $scope.clearAll = () => {
        if (!confirm("Clear all captured errors?")) return;
        $http.delete("/api/admin/errors").then(load, (err) => console.error(err));
      };

      load();
      const stop = $interval(() => {
        if ($scope.query.autoRefresh) load();
      }, 5000);
      $scope.$on("$destroy", () => $interval.cancel(stop));

      $scope.$watch("query.search", applyFilter);
      $scope.$watch("query.module", applyFilter);
    },
  ]);
