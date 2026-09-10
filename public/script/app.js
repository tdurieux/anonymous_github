import { reactive } from "vue";
import { createTimers, createListeners } from "./state.js";

// Page setup functions run inside Vue effect scopes.
export const mainController = function (state, http, location, timeout) {
      state.title = "Main";
      state.user = { status: "connection" };
      state.site_options;

      state.toasts = [];

      state.removeToast = function (toast) {
        const index = state.toasts.indexOf(toast);
        if (index === -1) return;
        state.toasts.splice(index, 1);
      };

      // Auto-dismiss toasts after a fixed delay so they don't pile up across
      // navigations (e.g. the "README not found" toast re-fired every time the
      // edit screen was reopened — see #246). Long-running operations that
      // mutate the toast (remove/refresh) will simply disappear once the
      // delay elapses; users can re-check status from the dashboard.
      state.addToast = function (toast) {
        state.toasts.push(toast);
        timeout(function () {
          state.removeToast(toast);
        }, 8000);
        return toast;
      };

      state.path = location.url();
      state.paths = location.path().substring(1).split("/");

      state.darkMode = function (on) {
        localStorage.setItem("darkMode", on);
        state.isDarkMode = on;
        const darkPrismLink = "/css/prism-okaidia.css";
        const lightPrismLink = "/css/prism.css";
        if (on) {
          $("body").addClass("dark-mode");
          let link = document.createElement("link");
          link.href = darkPrismLink;
          link.rel = "stylesheet";
          document.head.append(link);
          $(`link[href='${lightPrismLink}']`).remove();
        } else {
          $("body").removeClass("dark-mode");
          let link = document.createElement("link");
          link.href = lightPrismLink;
          link.rel = "stylesheet";
          document.head.append(link);
          $(`link[href='${darkPrismLink}']`).remove();
        }
        // Update Ko-fi floating button to match theme
        var kofiBtn = document.querySelector(".floatingchat-container-wrap-mo498 .floating-chat-kofi-text-container-wrap");
        if (kofiBtn) {
          kofiBtn.style.backgroundColor = on ? "#FAF9F6" : "#1A1815";
          kofiBtn.style.color = on ? "#1A1815" : "#FAF9F6";
        }
        state.emit("dark-mode", on);
      };

      state.darkMode(localStorage.getItem("darkMode") == "true");

      function getUser() {
        http.get("/api/user").then(
          (res) => {
            if (res) state.user = res.data;
          },
          () => {
            state.user = null;
          }
        );
      }
      getUser();

      function getOptions() {
        http.get("/api/options").then(
          (res) => {
            if (res) state.site_options = res.data;
          },
          () => {
            state.site_options = null;
          }
        );
      }
      getOptions();

      function getMessage() {
        http.get("/api/message").then(
          (res) => {
            if (res) state.generalMessage = res.data;
          },
          () => {
            state.generalMessage = null;
          }
        );
      }
      getMessage();

      function changedUrl(_, current) {
        if (current) {
          state.title = current.title;
        }
        state.path = location.url();
        state.paths = location.path().substring(1).split("/");
      }

      state.on("routeChange", changedUrl);
      state.on("routeUpdate", changedUrl);
    };

export const faqController = function (state, http) {
      const listen = createListeners();};

export const profileController = function (state, http, translate, timeout, quotaService) {
      state.terms = "";
      state.options = {
        expirationMode: "remove",
        update: false,
        image: true,
        pdf: true,
        notebook: true,
        loc: true,
        link: true,
      };
      state.saving = false;
      state.message = null;
      state.error = null;

      quotaService.load().then((quota) => {
        state.quota = quota;
      }, console.error);

      function getDefault() {
        http.get("/api/user/default").then((res) => {
          const data = res.data || {};
          if (data.terms) {
            state.terms = data.terms.join("\n");
          }
          state.options = Object.assign({}, state.options, data.options);
        });
      }
      getDefault();

      let savedTimer = null;
      state.saveDefault = ($event) => {
        if ($event && $event.preventDefault) $event.preventDefault();
        const params = {
          terms: state.terms
            .split("\n")
            .map((t) => t.trim())
            .filter((t) => t.length > 0),
          options: state.options,
        };
        state.saving = true;
        state.error = null;
        http.post("/api/user/default", params).then(
          () => {
            getDefault();
            state.saving = false;
            state.message = "Saved";
            if (savedTimer) timeout.cancel(savedTimer);
            savedTimer = timeout(() => {
              state.message = null;
            }, 2500);
          },
          (error) => {
            state.saving = false;
            const code = error && error.data && error.data.error;
            translate("ERRORS." + code).then((translation) => {
              state.error = translation;
            }, () => {
              state.error = "Unable to save your defaults. Please try again.";
            });
          }
        );
      };

      state.deleteAccount = () => {
        if (
          !confirm(
            "Delete your account? All your anonymized repositories, gists, and pull requests will be removed, and your personal data will be erased. This cannot be undone."
          )
        )
          return;
        state.deletingAccount = true;
        http.delete("/api/user").then(
          () => {
            window.location.href = "/";
          },
          () => {
            state.deletingAccount = false;
            state.deleteError =
              "Unable to delete the account. Please try again.";
          }
        );
      };
    };

export const claimController = function (state, http, location) {
      state.repoId = null;
      state.repoUrl = null;
      state.claim = () => {
        http
          .post("/api/repo/claim", {
            repoId: state.repoId,
            repoUrl: state.repoUrl,
          })
          .then(
            (res) => {
              location.url("/dashboard");
            },
            (err) => {
              state.error = err.data;
              state.claimForm.repoUrl.setValidity("not_found", false);
              state.claimForm.repoId.setValidity("not_found", false);
            }
          );
      };
    };

export const homeController = function (state, http, location, window, timeout) {
      if (state.user && !state.user.status) {
        location.url("/dashboard");
      }
      state.watch("user.status", () => {
        if (state.user && !state.user.status) {
          location.url("/dashboard");
        }
      });

      // "What you get": one screenshot, three tabs. The selected key drives
      // both the expanded description and the visible panel.
      state.features = [
        {
          key: "anonymize",
          num: "01",
          eyebrow: "Anonymize",
          title: "Double-anonymous,",
          accent: "your rules.",
          text:
            "Choose what reviewers may see: links, images, PDFs, notebooks, GitHub Pages. Add your own terms, with regex if you need it, and pick the expiration date.",
          cta: "Start an anonymization",
          href: "/anonymize",
          url: "anonymous.4open.science/anonymize",
          img: "/imgs/anonymize.png",
          alt: "The anonymize form: source repository, terms to redact, options and a live README preview",
        },
        {
          key: "review",
          num: "02",
          eyebrow: "Review",
          title: "Reviewers browse",
          accent: "the real thing.",
          text:
            "Highlighted source code, rendered PDFs, images, and notebooks, in a familiar file explorer. GitHub Pages is also supported.",
          cta: "Open the example",
          href: "https://anonymous.4open.science/r/840c8c57-3c32-451e-bf12-0e20be300389/",
          target: "_self",
          url: "anonymous.4open.science/r/840c8c57-…",
          img: "/imgs/explorer.png",
          alt: "The repository explorer with a file tree and a rendered README",
        },
        {
          key: "manage",
          num: "03",
          eyebrow: "Manage",
          title: "One dashboard,",
          accent: "until the decision.",
          text:
            "Monitor views, edit configuration, remove or update your repository. Program chairs can group submissions under a conference with one shared expiry.",
          cta: "Open the dashboard",
          href: "/dashboard",
          needsUser: true,
          url: "anonymous.4open.science/dashboard",
          img: "/imgs/dashboard.png",
          alt: "The dashboard listing anonymized repositories with status, views and expiry",
        },
      ];
      state.feature = state.features[0].key;
      state.selectFeature = function (key) {
        state.feature = key;
      };
      // Signed-out visitors cannot open the dashboard; send them to sign in.
      state.featureHref = function (f) {
        return f.needsUser && !state.user ? "/github/login" : f.href;
      };
      state.featureTarget = function (f) {
        return f.needsUser && !state.user ? "_self" : f.target || undefined;
      };
      state.featureKeydown = function ($event, index) {
        const step = {
          ArrowDown: 1,
          ArrowRight: 1,
          ArrowUp: -1,
          ArrowLeft: -1,
          Home: "first",
          End: "last",
        }[$event.key];
        if (step === undefined) return;
        $event.preventDefault();
        const n = state.features.length;
        const next =
          step === "first" ? 0 : step === "last" ? n - 1 : (index + step + n) % n;
        state.feature = state.features[next].key;
        timeout(() => {
          const el = window.document.getElementById("feature-tab-" + state.feature);
          if (el) el.focus();
        });
      };

      state.cards = [
        { key: "repositories", total: 0, label: "repositories anonymized" },
        { key: "users", total: 0, label: "researchers" },
        { key: "pageViews", total: 0, label: "page views" },
        { key: "pullRequests", total: 0, label: "pull requests" },
      ];
      function getStat() {
        http.get("/api/stat/").then((res) => {
          state.stat = res.data;
          state.cards[0].total = res.data.nbRepositories;
          state.cards[1].total = res.data.nbUsers;
          state.cards[2].total = res.data.nbPageViews;
          state.cards[3].total = res.data.nbPullRequests;
        });
      }
      getStat();

      function buildSeriesView(series) {
        const view = {
          series: series,
          bars: [],
          viewW: 100,
          deltaToday: 0,
          pctChange: 0,
          pctAbs: 0,
          isUp: true,
        };
        if (!series || series.length < 2) return view;
        // Bars represent the *daily increment* (today - yesterday), not the
        // cumulative total. The big number above the chart shows the total.
        const deltas = new Array(series.length - 1);
        for (let i = 1; i < series.length; i++) {
          deltas[i - 1] = series[i] - series[i - 1];
        }
        const n = deltas.length;
        const max = Math.max.apply(null, deltas);
        const min = Math.min.apply(null, deltas);
        // Anchor scale to zero so visually small days look small even when all
        // deltas are positive; only fall back to min when there are negatives.
        const base = Math.min(0, min);
        const range = max - base || 1;
        view.viewW = n * 2;
        view.bars = new Array(n);
        for (let i = 0; i < n; i++) {
          const norm = (deltas[i] - base) / range;
          const h = Math.max(1.5, norm * 34);
          view.bars[i] = {
            x: (i * 2 + 0.25).toFixed(2),
            y: (36 - h).toFixed(2),
            w: "1.5",
            h: h.toFixed(2),
          };
        }
        view.deltaToday = deltas[n - 1];
        if (n >= 2) {
          const prior = deltas[n - 2];
          if (prior) {
            view.pctChange = ((view.deltaToday - prior) / prior) * 100;
          }
        }
        view.pctAbs = Math.round(Math.abs(view.pctChange));
        view.isUp = view.pctChange >= 0;
        return view;
      }

      state.history = {
        repositories: buildSeriesView([]),
        users: buildSeriesView([]),
        pageViews: buildSeriesView([]),
        pullRequests: buildSeriesView([]),
      };
      http.get("/api/stat/history?days=60").then((res) => {
        const rows = res.data || [];
        state.history = {
          repositories: buildSeriesView(rows.map((r) => r.nbRepositories || 0)),
          users: buildSeriesView(rows.map((r) => r.nbUsers || 0)),
          pageViews: buildSeriesView(rows.map((r) => r.nbPageViews || 0)),
          pullRequests: buildSeriesView(rows.map((r) => r.nbPullRequests || 0)),
        };
      });
    };

export const unifiedDashboardController = function (state, http, location, promises, window, quotaService) {
      const timers = createTimers();
      state.on("routeLeave", function () {
        $('[data-toggle="tooltip"]').tooltip("dispose");
      });
      state.watch("user.status", () => {
        if (state.user == null) {
          location.url("/");
        }
      });
      if (state.user == null) {
        location.url("/");
      }

      timers.timeout(() => {
        $('[data-toggle="tooltip"]').tooltip();
      }, 250);

      state.items = [];
      state.search = "";
      state.loading = true;

      // Status buckets used by the Status filter. Raw statuses are mapped
      // onto these keys so in-progress and error items can be filtered too.
      state.statusKeyLabels = {
        ready: "Ready",
        progress: "In progress",
        error: "Error",
        expired: "Expired",
        removed: "Removed",
      };
      const inProgress = ["queue", "download", "downloaded", "preparing", "anonymizing"];
      function statusKey(status) {
        if (status === "ready" || status === "error") return status;
        if (status === "expired" || status === "expiring") return "expired";
        if (status === "removed" || status === "removing") return "removed";
        if (inProgress.indexOf(status) > -1) return "progress";
        return "progress";
      }
      // An in-progress item whose last activity is older than this is
      // probably stuck; the row says so instead of showing "Downloading".
      const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

      const dashboardPrefsKey = "dashboard.filterPrefs";
      const dashboardPrefDefaults = {
        typeFilter: "all",
        filters: {
          status: { ready: true, progress: true, error: true, expired: true, removed: false },
        },
        orderBy: "-anonymizeDate",
      };
      const savedDashboardPrefs = loadFilterPrefs(dashboardPrefsKey) || {};
      state.typeFilter = savedDashboardPrefs.typeFilter || dashboardPrefDefaults.typeFilter;
      state.filters = {
        status: Object.assign(
          {},
          dashboardPrefDefaults.filters.status,
          (savedDashboardPrefs.filters && savedDashboardPrefs.filters.status) || {}
        ),
      };
      state.orderBy = savedDashboardPrefs.orderBy || dashboardPrefDefaults.orderBy;

      // ---- Sorting -------------------------------------------------------
      // `orderBy` is kept as the Angular orderBy expression ("-field" for
      // descending) so saved preferences stay compatible.
      const sortFields = {
        _name: { label: "Name", defaultDesc: false },
        anonymizeDate: { label: "Anonymize date", defaultDesc: true },
        status: { label: "Status", defaultDesc: false },
        lastView: { label: "Last view", defaultDesc: true },
        pageView: { label: "Views", defaultDesc: true },
        "options.expirationDate": { label: "Expiration", defaultDesc: false },
      };
      state.sortFields = sortFields;
      state.sortField = () => state.orderBy.replace(/^-/, "");
      state.sortDesc = () => state.orderBy.charAt(0) === "-";
      state.sortLabel = () => {
        const f = sortFields[state.sortField()];
        return f ? f.label : "Custom";
      };
      state.isSortedBy = (field) => state.sortField() === field;
      state.setSort = (field, desc) => {
        if (typeof desc !== "boolean") {
          desc = state.isSortedBy(field)
            ? !state.sortDesc()
            : !!(sortFields[field] && sortFields[field].defaultDesc);
        }
        state.orderBy = (desc ? "-" : "") + field;
      };
      state.toggleSortDirection = () => {
        state.setSort(state.sortField(), !state.sortDesc());
      };

      state.watchGroup(
        ["typeFilter", "orderBy"],
        () => {
          saveFilterPrefs(dashboardPrefsKey, {
            typeFilter: state.typeFilter,
            filters: state.filters,
            orderBy: state.orderBy,
          });
        }
      );
      state.watch(
        "filters",
        () => {
          saveFilterPrefs(dashboardPrefsKey, {
            typeFilter: state.typeFilter,
            filters: state.filters,
            orderBy: state.orderBy,
          });
        },
        true
      );

      // ---- Quota (shared with the settings page via quotaService) --------
      quotaService.load().then((quota) => {
        state.quota = quota;
      }, console.error);

      // ---- Items ---------------------------------------------------------
      // Fields shared by repositories, pull requests and gists. Records that
      // lost their identifier (legacy data) are flagged as broken instead of
      // rendering an empty link to /pr/undefined/.
      function decorateItem(item, id, name, source, editUrl, viewUrl) {
        if (!item.pageView) item.pageView = 0;
        if (!item.lastView) item.lastView = "";
        item.options = item.options || {};
        item.options.terms = (item.options.terms || []).filter((f) => f);
        item._id = id || "";
        item._source = source;
        item._broken = !id;
        item._name = id || source || "(unnamed)";
        item._editUrl = id ? editUrl : null;
        item._viewUrl = id ? viewUrl : null;
        if (item._broken) {
          item.status = "error";
          item.statusMessage = "incomplete_record";
        }
        item._statusKey = statusKey(item.status);
        const last = item.anonymizeDate || item.lastView;
        item._stale =
          item._statusKey === "progress" &&
          !!last &&
          Date.now() - new Date(last).getTime() > STALE_AFTER_MS;
        // What the Expires column should show.
        if (item.status === "expired" || item.status === "expiring") {
          item._expiry = { kind: "expired", date: item.options.expirationDate };
        } else if (item.status !== "ready") {
          item._expiry = { kind: "none" };
        } else if (item.options.expirationMode === "never" || !item.options.expirationDate) {
          item._expiry = { kind: "never" };
        } else {
          item._expiry = { kind: "date", date: item.options.expirationDate };
        }
        return item;
      }

      function safeGet(url) {
        return http.get(url).then(
          (res) => res.data || [],
          (err) => {
            console.error(err);
            return [];
          }
        );
      }

      // All three lists load in parallel and are merged once, so the table
      // does not re-sort three times while it fills in.
      function loadAll() {
        state.loading = true;
        return promises
          .all([
            safeGet("/api/user/anonymized_repositories"),
            safeGet("/api/user/anonymized_pull_requests"),
            safeGet("/api/user/anonymized_gists"),
          ])
          .then((results) => {
            const repos = results[0];
            const prs = results[1];
            const gists = results[2];
            const items = [];
            repos.forEach((repo) => {
              repo._type = "repo";
              const src = repo.source || {};
              items.push(
                decorateItem(
                  repo,
                  repo.repoId,
                  repo.repoId,
                  src.fullName,
                  "/anonymize/" + repo.repoId,
                  "/r/" + repo.repoId + "/"
                )
              );
            });
            prs.forEach((pr) => {
              pr._type = "pr";
              const src = pr.source || {};
              items.push(
                decorateItem(
                  pr,
                  pr.pullRequestId,
                  pr.pullRequestId,
                  src.repositoryFullName + "#" + src.pullRequestId,
                  "/pull-request-anonymize/" + pr.pullRequestId,
                  "/pr/" + pr.pullRequestId + "/"
                )
              );
            });
            gists.forEach((g) => {
              g._type = "gist";
              const src = g.source || {};
              items.push(
                decorateItem(
                  g,
                  g.gistId,
                  g.gistId,
                  src.gistId,
                  "/gist-anonymize/" + g.gistId,
                  "/gist/" + g.gistId + "/"
                )
              );
            });
            state.items = items;
            state.loading = false;
          });
      }
      loadAll();

      // Whole row opens the anonymized view; clicks on links, buttons and the
      // actions menu keep their own behaviour.
      state.openItem = (item, $event) => {
        if (!item._viewUrl) return;
        const target = $event && $event.target;
        if (target && target.closest && target.closest("a, button, .dropdown, input")) return;
        window.location.href = item._viewUrl;
      };

      state.hiddenStatusCount = () =>
        Object.keys(state.filters.status).filter((k) => state.filters.status[k] === false).length;
      state.hasHiddenStatus = () => state.hiddenStatusCount() > 0;

      state.hasActiveFilters = () =>
        state.typeFilter !== "all" ||
        state.search.trim().length > 0 ||
        Object.keys(state.filters.status).some((k) => state.filters.status[k] === false);

      state.clearFilters = () => {
        state.typeFilter = "all";
        state.search = "";
        Object.keys(state.filters.status).forEach((k) => {
          state.filters.status[k] = true;
        });
      };

      function waitRepoToBeReady(repoId, callback) {
        http.get("/api/repo/" + repoId).then((res) => {
          for (const item of state.items) {
            if (item._type === "repo" && item.repoId == repoId) {
              item.status = res.data.status;
              break;
            }
          }
          if (
            res.data.status == "ready" ||
            res.data.status == "error" ||
            res.data.status == "removed" ||
            res.data.status == "expired"
          ) {
            callback(res.data);
            return;
          }
          timers.timeout(() => waitRepoToBeReady(repoId, callback), 2500);
        });
      }

      const labelOf = (t) =>
        t === "repo" ? "repository" : t === "gist" ? "gist" : "pull request";
      const apiBaseOf = (t) =>
        t === "repo" ? "/api/repo" : t === "gist" ? "/api/gist" : "/api/pr";

      state.removeItem = (item) => {
        const label = labelOf(item._type);
        if (confirm(`Are you sure that you want to remove the ${label} ${item._id}?`)) {
          const toast = reactive({
            title: `Removing ${item._id}...`,
            date: new Date(),
            body: `The ${label} ${item._id} is going to be removed.`,
          });
          state.addToast(toast);
          const endpoint = `${apiBaseOf(item._type)}/${item._id}`;
          http.delete(endpoint).then(
            () => {
              if (item._type === "repo") {
                waitRepoToBeReady(item._id, () => {
                  toast.title = `${item._id} is removed.`;
                  toast.body = `The ${label} ${item._id} is removed.`;

                });
              } else {
                toast.title = `${item._id} is removed.`;
                toast.body = `The ${label} ${item._id} is removed.`;
                loadAll();
              }
            },
            (error) => {
              toast.title = `Error during the removal of ${item._id}.`;
              toast.body = error.body;
              loadAll();
            }
          );
        }
      };

      state.refreshItem = (item) => {
        const label = labelOf(item._type);
        const toast = reactive({
          title: `Refreshing ${item._id}...`,
          date: new Date(),
          body: `The ${label} ${item._id} is going to be refreshed.`,
        });
        state.addToast(toast);
        const endpoint = `${apiBaseOf(item._type)}/${item._id}/refresh`;
        http.post(endpoint).then(
          () => {
            if (item._type === "repo") {
              waitRepoToBeReady(item._id, () => {
                toast.title = `${item._id} is refreshed.`;
                toast.body = `The ${label} ${item._id} is refreshed.`;

              });
            } else {
              toast.title = `${item._id} is refreshed.`;
              toast.body = `The ${label} ${item._id} is refreshed.`;
              loadAll();
            }
          },
          (error) => {
            toast.title = `Error during the refresh of ${item._id}.`;
            toast.body = error.body;
            loadAll();
          }
        );
      };

      state.extendItem = (item) => {
        const label = labelOf(item._type);
        const toast = reactive({
          title: `Extending ${item._id}...`,
          date: new Date(),
          body: `The expiration of ${label} ${item._id} is going to be extended by 6 months.`,
        });
        state.addToast(toast);
        const endpoint = `${apiBaseOf(item._type)}/${item._id}/extend`;
        http.post(endpoint).then(
          () => {
            if (item._type === "repo") {
              waitRepoToBeReady(item._id, () => {
                toast.title = `${item._id} is extended.`;
                toast.body = `The expiration of ${label} ${item._id} is extended by 6 months.`;

              });
            } else {
              toast.title = `${item._id} is extended.`;
              toast.body = `The expiration of ${label} ${item._id} is extended by 6 months.`;
              loadAll();
            }
          },
          (error) => {
            toast.title = `Error during the extension of ${item._id}.`;
            toast.body = (error.data && error.data.error) || error.body;
            loadAll();
          }
        );
      };

      state.itemFilter = (item) => {
        if (state.typeFilter !== "all" && item._type !== state.typeFilter) return false;
        if (state.filters.status[item._statusKey] === false) return false;
        const needle = state.search.trim().toLowerCase();
        if (needle.length == 0) return true;
        if (item._source && String(item._source).toLowerCase().indexOf(needle) > -1) return true;
        if (item._id && String(item._id).toLowerCase().indexOf(needle) > -1) return true;
        if (item.conference && String(item.conference).toLowerCase().indexOf(needle) > -1) return true;
        return false;
      };
    };

export const dashboardController = function (state, location) {
      location.url("/dashboard");
    };

export const prDashboardController = function (state, location) {
      location.url("/dashboard");
    };

export const statusController = function (state, http, params) {
      const timers = createTimers();
      state.repoId = params.repoId;
      state.repo = null;
      state.progress = 0;
      state.rateLimitResetAt = 0;
      state.rateLimitCountdown = "";

      var countdownTimer = null;
      let pollTimer = null;
      let destroyed = false;
      function startRateLimitCountdown(resetAt) {
        state.rateLimitResetAt = resetAt;
        if (countdownTimer) timers.interval.cancel(countdownTimer);
        function tick() {
          var remaining = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
          if (remaining <= 0) {
            state.rateLimitCountdown = "";
            state.rateLimitResetAt = 0;
            timers.interval.cancel(countdownTimer);
            countdownTimer = null;
          } else {
            var min = Math.floor(remaining / 60);
            var sec = remaining % 60;
            state.rateLimitCountdown = min > 0
              ? min + "m " + sec + "s"
              : sec + "s";
          }

        }
        tick();
        countdownTimer = timers.interval(tick, 1000);
      }
      state.on("dispose", function () {
        destroyed = true;
        if (countdownTimer) timers.interval.cancel(countdownTimer);
        if (pollTimer) timers.timeout.cancel(pollTimer);
      });

      function parseStatusMessage(msg) {
        if (!msg) return msg;
        var m = msg.match(/^rate_limited:(\d+)$/);
        if (m) {
          startRateLimitCountdown(parseInt(m[1], 10));
          return null;
        }
        state.rateLimitResetAt = 0;
        return msg;
      }

      state.getStatus = () => {
        if (destroyed) return;
        http
          .get("/api/repo/" + state.repoId, {
            repoId: state.repoId,
            repoUrl: state.repoUrl,
          })
          .then(
            (res) => {
              if (destroyed) return;
              state.repo = res.data;
              if (res.data.rateLimitResetAt) {
                startRateLimitCountdown(res.data.rateLimitResetAt);
              } else {
                state.repo.statusMessage = parseStatusMessage(state.repo.statusMessage);
              }
              if (state.repo.status == "ready") {
                state.progress = 100;
              } else if (state.repo.status == "queue") {
                state.progress = 10;
              } else if (state.repo.status == "downloaded") {
                state.progress = 50;
              } else if (state.repo.status == "download") {
                state.progress = 25;
              } else if (state.repo.status == "preparing") {
                state.progress = 25;
              } else if (state.repo.status == "anonymizing") {
                state.progress = 75;
              }
              var shouldPoll = !["ready", "removed", "expired"].includes(state.repo.status);
              if (state.repo.status == "error" && !state.rateLimitResetAt) {
                shouldPoll = false;
              }
              if (shouldPoll) {
                pollTimer = timers.timeout(state.getStatus, 2000);
              }
            },
            (err) => {
              state.error = err.data.error;
            }
          );
      };
      state.getStatus();
    };

export const anonymizeController = function (state, http, html, params, location, translate, timeout) {
      // Unified state
      state.sourceUrl = "";
      state.githubConnection = undefined;
      state.githubConnections = null;
      state.grantGitHubAccess = () => {
        const draft = {};
        for (const key of ["sourceUrl", "terms", "repoId", "pullRequestId", "gistId", "source", "options", "conference", "githubConnection"]) draft[key] = state[key];
        sessionStorage.setItem("github-access-draft", JSON.stringify({ path: location.path(), savedAt: Date.now(), draft }));
        const returnTo = location.path();
        const repository = parseRepoFullName(state.sourceUrl) || "";
        const route = state.githubConnections?.appConnected ? "/github/app/install" : "/github/app/login";
        window.location.href = route + "?returnTo=" + encodeURIComponent(returnTo) + "&repository=" + encodeURIComponent(repository) + "&install=1";
      };
      state.chooseGitHubConnection = async (value) => {
        state.githubConnection = value;
        state.readme = "";
        if (state.sourceUrl) await refreshGitHubAccess();
      };
      state.detectedType = null; // 'repo' | 'pr' | 'gist'
      state.repoId = "";
      state.pullRequestId = "";
      state.gistId = "";
      state.terms = "";
      state.defaultTerms = "";
      state.branches = [];
      state.source = { branch: "", commit: "" };
      state.options = {
        expirationMode: "remove",
        expirationDate: new Date(),
        update: false,
        image: true,
        pdf: true,
        notebook: true,
        link: true,
        body: true,
        title: true,
        origin: false,
        diff: true,
        content: true,
        comments: true,
        username: true,
        date: true,
      };
      // Default expiration: 6 months from today.
      function defaultExpirationDate() {
        const d = new Date();
        d.setMonth(d.getMonth() + 6);
        return d;
      }
      state.options.expirationDate = defaultExpirationDate();
      // Format a Date to a "yyyy-MM-dd" string using local date parts. Using
      // toISOString() here would convert to UTC and can shift the bound by a
      // day for users in negative-offset timezones, which the native date
      // picker (local calendar) would then render off by one.
      function toLocalDateString(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
      }
      // Bound the expiration date: no earlier than today, no later than 1 year
      // out.
      state.minExpirationDate = toLocalDateString(new Date());
      const maxDate = new Date();
      maxDate.setFullYear(maxDate.getFullYear() + 1);
      state.maxExpirationDate = toLocalDateString(maxDate);
      state.anonymize_readme = "";
      state.readme = "";
      state.html_readme = "";
      state.isUpdate = false;

      function getDefault(cb) {
        http.get("/api/user/default").then((res) => {
          const data = res.data;
          if (data.terms) {
            state.defaultTerms = data.terms.join("\n");
          }
          state.options = Object.assign({}, state.options, data.options);
          // Honour a server-provided default date, otherwise fall back to the
          // 6-month default. (Previously this re-added the offset on top of the
          // already-defaulted date, doubling it.)
          state.options.expirationDate =
            data.options && data.options.expirationDate
              ? new Date(data.options.expirationDate)
              : defaultExpirationDate();
          if (cb) cb();
        });
      }

      // Helper to safely set validity on form fields
      function setValidity(field, key, value) {
        if (state.anonymize && state.anonymize[field]) {
          state.anonymize[field].setValidity(key, value);
        }
      }

      function parseRepoFullName(url) {
        try {
          const parsed = parseGithubUrl(url);
          if (parsed && parsed.owner && parsed.repo) {
            return parsed.owner + "/" + parsed.repo;
          }
        } catch (_) { /* sourceUrl not yet parseable */ }
        return null;
      }

      function sourceRepositoryID() {
        if (!state.isUpdate || !state._originalRepositoryID) return undefined;
        const currentFullName = parseRepoFullName(state.sourceUrl);
        return currentFullName === state._originalFullName
          ? state._originalRepositoryID
          : undefined;
      }

      async function refreshGitHubAccess() {
        state._preservingDraft = true;
        try { await state.urlSelected(true); }
        finally { state._preservingDraft = false; }
      }

      async function restoreGitHubDraft() {
        let saved;
        try { saved = JSON.parse(sessionStorage.getItem("github-access-draft") || "null"); }
        catch (_) { return false; }
        if (!saved || saved.path !== location.path() || Date.now() - saved.savedAt >= 30 * 60000) return false;
        for (const key of ["sourceUrl", "terms", "repoId", "pullRequestId", "gistId", "source", "options", "conference", "githubConnection"]) {
          if (Object.prototype.hasOwnProperty.call(saved.draft, key)) state[key] = saved.draft[key];
        }
        if (state.options.expirationDate) state.options.expirationDate = new Date(state.options.expirationDate);
        await refreshGitHubAccess();
        sessionStorage.removeItem("github-access-draft");
        return true;
      }

      getDefault(() => {
        if (!params.repoId && !params.pullRequestId && !params.gistId) timeout(restoreGitHubDraft, 0);
        // Edit mode: repo
        if (params.repoId && params.repoId != "") {
          state.isUpdate = true;
          state.detectedType = "repo";
          state.repoId = params.repoId;
          http.get("/api/repo/" + state.repoId).then(
            async (res) => {
              state.githubConnection = res.data.connection || "oauth";
              state.sourceUrl = "https://github.com/" + res.data.source.fullName;
              state._originalFullName = res.data.source.fullName;
              state.terms = res.data.options.terms.filter((f) => f).join("\n");
              state.source = res.data.source;
              state.role = res.data.role || "owner";
              state.coauthors = res.data.coauthors || [];
              // Remember the saved branch so the source.branch watcher knows
              // not to bump source.commit to GitHub HEAD on edit-page load
              // (#360). Without this, just opening the Edit form silently
              // pulled in any new commits and saving — even to toggle a
              // checkbox — picked them up.
              state._originalBranch = res.data.source.branch;
              state.options = Object.assign({}, state.options, res.data.options);
              state.conference = res.data.conference;
              state._originalConference = res.data.conference;
              state.repositoryID = res.data.source.repositoryID;
              state._originalRepositoryID = res.data.source.repositoryID;
              if (res.data.options.expirationDate) {
                state.options.expirationDate = new Date(res.data.options.expirationDate);
              }
              if (await restoreGitHubDraft()) return;
              await Promise.all([getRepoDetails(), getReadme()]);
              anonymizeReadme();

            },
            () => { location.url("/404"); }
          );
        }
        // Edit mode: PR
        if (params.pullRequestId && params.pullRequestId != "") {
          state.isUpdate = true;
          state.detectedType = "pr";
          state.pullRequestId = params.pullRequestId;
          http.get("/api/pr/" + state.pullRequestId).then(
            async (res) => {
              state.githubConnection = res.data.connection || "oauth";
              state.sourceUrl = "https://github.com/" + res.data.source.repositoryFullName + "/pull/" + res.data.source.pullRequestId;
              state.terms = res.data.options.terms.filter((f) => f).join("\n");
              state.source = res.data.source;
              state.options = Object.assign({}, state.options, res.data.options);
              state.conference = res.data.conference;
              state._originalConference = res.data.conference;
              if (res.data.options.expirationDate) {
                state.options.expirationDate = new Date(res.data.options.expirationDate);
              }
              if (await restoreGitHubDraft()) return;
              try {
                state.details = (await http.get(`/api/pr/${res.data.source.repositoryFullName}/${res.data.source.pullRequestId}`, { params: { connection: state.githubConnection } })).data;
              } catch (error) {
                const code = error && error.data && error.data.error;
                if (code) {
                  translate("ERRORS." + code).then((translation) => {
                    state.addToast({ title: "Error", date: new Date(), body: translation });
                    state.error = translation;
                  }, console.error);
                  displayErrorMessage(code);
                }
              }

            },
            () => { location.url("/404"); }
          );
        }
        // Edit mode: Gist
        if (params.gistId && params.gistId != "") {
          state.isUpdate = true;
          state.detectedType = "gist";
          state.gistId = params.gistId;
          http.get("/api/gist/" + state.gistId).then(
            async (res) => {
              state.sourceUrl = "https://gist.github.com/" + res.data.source.gistId;
              state.terms = res.data.options.terms.filter((f) => f).join("\n");
              state.source = res.data.source;
              state.options = Object.assign({}, state.options, res.data.options);
              state.conference = res.data.conference;
              state._originalConference = res.data.conference;
              if (res.data.options.expirationDate) {
                state.options.expirationDate = new Date(res.data.options.expirationDate);
              }
              if (await restoreGitHubDraft()) return;
              state.details = (await http.get(`/api/gist/source/${res.data.source.gistId}`)).data;

            },
            () => { location.url("/404"); }
          );
        }
      });

      http.get("/github/connections").then(res => { state.githubConnections = res.data; }).catch(() => {});

      // URL change handler - auto-detect type
      state.urlSelected = async (preserveDraft = false) => {
        if (!preserveDraft) state.terms = state.defaultTerms;
        if (!preserveDraft && !state.isUpdate) {
          state.repoId = "";
          state.pullRequestId = "";
          state.gistId = "";
        }
        state.details = null;
        state.branches = [];
        if (!preserveDraft) state.source = { type: "GitHubStream", branch: "", commit: "" };
        state.anonymize_readme = "";
        state.readme = "";
        state.html_readme = "";
        state.detectedType = null;

        let o;
        try {
          o = parseGithubUrl(state.sourceUrl);
        } catch (error) {
          setValidity("sourceUrl", "github", false);
          return;
        }
        setValidity("sourceUrl", "github", true);
        try {
          if (o.gistId && !o.repo) {
            state.detectedType = "gist";
            state.source = { gistId: o.gistId };
            await getGistDetails();
          } else if (o.pullRequestId) {
            state.detectedType = "pr";
            state.source = { repositoryFullName: o.owner + "/" + o.repo, pullRequestId: o.pullRequestId };
            await getPrDetails();
          } else {
            state.detectedType = "repo";
            await Promise.all([getRepoDetails(), getReadme()]);
            anonymizeReadme();
          }
        } catch (error) {
          return;
        }

        $('[data-toggle="tooltip"]').tooltip();
      };
      $('[data-toggle="tooltip"]').tooltip();

      // ========== REPO LOGIC ==========

      state.watch("source.branch", async () => {
        if (state.detectedType !== "repo") return;
        const selected = state.branches.filter((f) => f.name == state.source.branch)[0];
        if (!selected) return;
        // In update mode, preserve the saved commit while the branch is
        // unchanged — see #360. Saving the form (e.g. to turn off
        // auto-update) used to bump the commit to GitHub HEAD because this
        // watcher overwrote it on edit-page load.
        const keepSavedCommit =
          state.isUpdate &&
          state._originalBranch === state.source.branch &&
          !!state.source.commit;
        if (!keepSavedCommit && !(state._preservingDraft && state.source.commit)) {
          state.source.commit = selected.commit;
        }
        state.readme = selected.readme;
        await getReadme();
        anonymizeReadme();

      });

      state.getBranches = async (force) => {
        const o = parseGithubUrl(state.sourceUrl);
        try {
          const branches = await http.get(`/api/repo/${o.owner}/${o.repo}/branches`, {
            params: { anonymizedRepoId: state.isUpdate && params.repoId && parseRepoFullName(state.sourceUrl) === state._originalFullName ? params.repoId : undefined, connection: state.githubConnection, force: force === true ? "1" : "0", repositoryID: sourceRepositoryID() },
          });
          state.branches = branches.data;
          state.sourceUnreachable = false;
          if (!state.source.branch) {
            state.source.branch = state.details.defaultBranch;
          }
          const selected = state.branches.filter((b) => b.name == state.source.branch);
          if (selected.length > 0) {
            // When the user explicitly clicks refresh (force=true), always
            // update the commit to the latest on the branch. Only preserve
            // the saved commit on the initial edit-page load (#360).
            const keepSavedCommit =
              !force &&
              state.isUpdate &&
              !state.options.update &&
              state._originalBranch === state.source.branch &&
              !!state.source.commit;
            if (!keepSavedCommit && !(state._preservingDraft && state.source.commit)) {
              state.source.commit = selected[0].commit;
            }
            state.readme = selected[0].readme;
            await getReadme(force);
          }
        } catch (error) {
          state.branches = [];
          state.sourceUnreachable = error && (error.status === 404 || (error.data && error.data.error === "repo_not_found"));
          const code = (error && error.data && error.data.error) || (error && error.status === 404 ? "repo_not_found" : "unknown_error");
          translate("ERRORS." + code).then((translation) => {
            state.toasts = state.toasts || [];
            state.addToast({ title: "Error", date: new Date(), body: translation });
            state.error = translation;
          }, console.error);
          if (typeof setValidity === "function") {
            setValidity("sourceUrl", "missing", false);
          }
        }

      };

      async function getRepoDetails() {
        const o = parseGithubUrl(state.sourceUrl);
        try {
          resetValidity();
          // force=1 so newly enabled features (e.g. GitHub Pages — see
          // #364) are reflected without waiting for the cached metadata to
          // expire. The endpoint hits the GitHub API once.
          const res = await http.get(`/api/repo/${o.owner}/${o.repo}/`, {
            params: { anonymizedRepoId: state.isUpdate && params.repoId && parseRepoFullName(state.sourceUrl) === state._originalFullName ? params.repoId : undefined, connection: state.githubConnection, repositoryID: sourceRepositoryID(), force: "1" },
          });
          state.details = res.data;
          if (state.details && state.details.id) {
            state.repositoryID = state.details.id;
          }
          if (!state.repoId) {
            state.repoId = state.details.repo + "-" + generateRandomId(4);
          }
          await state.getBranches();
        } catch (error) {
          if (error.data) {
            translate("ERRORS." + error.data.error).then((translation) => {
              state.addToast({ title: "Error", date: new Date(), body: translation });
              state.error = translation;
            }, console.error);
            displayErrorMessage(error.data.error);
          }
          setValidity("sourceUrl", "missing", false);
          throw error;
        }
      }

      async function getReadme(force) {
        if (state.readme && !force) return state.readme;
        const o = parseGithubUrl(state.sourceUrl);
        try {
          const res = await http.get(`/api/repo/${o.owner}/${o.repo}/readme`, {
            params: { anonymizedRepoId: state.isUpdate && params.repoId && parseRepoFullName(state.sourceUrl) === state._originalFullName ? params.repoId : undefined, connection: state.githubConnection, force: force === true ? "1" : "0", branch: state.source.branch, repositoryID: sourceRepositoryID() },
          });
          state.readme = res.data;
        } catch (error) {
          state.readme = "";
        }
      }

      // Both anonymizeReadme() and anonymizePrContent() used to reimplement
      // ContentAnonimizer client-side, which drifted from the backend (term
      // boundary fixes, accent matching, custom replacements all only landed
      // in the server). Send the snippets to /api/anonymize-preview instead so
      // the preview matches what reviewers see byte-for-byte. Calls are
      // debounced and the in-flight request is dropped on the next change so
      // typing in the form stays responsive.

      function previewOptions() {
        const opts = {
          terms: state.terms ? state.terms.split("\n") : [],
          image: !!state.options.image,
          link: !!state.options.link,
          repoId: state.repoId,
        };
        if (state.source && state.source.branch) {
          opts.branchName = state.source.branch;
        }
        try {
          const o = parseGithubUrl(state.sourceUrl);
          opts.repoName = `${o.owner}/${o.repo}`;
        } catch (_) { /* sourceUrl not yet parseable */ }
        return opts;
      }

      // Single-flight + debounced wrapper. Returns a promise that resolves
      // with the latest server result; intermediate calls are coalesced.
      function makePreviewBatcher(buildBody, applyResult) {
        let pendingTimer = null;
        let inflightToken = 0;
        return function schedule() {
          if (pendingTimer) timeout.cancel(pendingTimer);
          pendingTimer = timeout(() => {
            pendingTimer = null;
            const myToken = ++inflightToken;
            const body = buildBody();
            if (!body) return;
            http.post("/api/anonymize-preview", body).then(
              (res) => {
                if (myToken !== inflightToken) return; // stale
                applyResult(res.data);
              },
              () => { /* ignore preview errors; no UI feedback needed */ }
            );
          }, 200);
        };
      }

      const scheduleReadmePreview = makePreviewBatcher(
        () => {
          if (!state.readme) return null;
          return { content: state.readme, options: previewOptions() };
        },
        (data) => {
          state.anonymize_readme = data.content || "";
          let baseUrl = "";
          try {
            const o = parseGithubUrl(state.sourceUrl);
            // Fall back to the repo's default branch when source.branch
            // hasn't loaded yet — without this, relative <img src="./X">
            // resolved against a baseUrl like ".../raw//" (no branch
            // segment), so the browser fetched ".../raw/X" and 404'd
            // (#407).
            const branch =
              state.source.branch ||
              (state.details && state.details.defaultBranch) ||
              "main";
            baseUrl = `https://github.com/${o.owner}/${o.repo}/raw/${branch}/`;
          } catch (_) { /* fall through with empty base */ }
          const html = renderMD(state.anonymize_readme, baseUrl);
          state.html_readme = html;
          timeout(Prism.highlightAll, 150);
        }
      );

      function anonymizeReadme() {
        if (!state.anonymize || !state.anonymize.terms) return;
        // The "regex characters detected" hint is informational, not a blocker
        // — IP addresses, escaped chars, etc. are all legitimate terms (#430).
        state.termsRegexWarning =
          !!state.terms && !!state.terms.match(/[-[\]{}()*+?.,\\^$|#]/g);
        scheduleReadmePreview();
      }

      // ========== PR LOGIC ==========
      async function getPrDetails() {
        const o = parseGithubUrl(state.sourceUrl);
        try {
          resetValidity();
          const res = await http.get(`/api/pr/${o.owner}/${o.repo}/${o.pullRequestId}`, { params: { connection: state.githubConnection } });
          state.details = res.data;
          if (!state.pullRequestId) {
            state.pullRequestId = o.repo + "-PR" + o.pullRequestId + "-" + generateRandomId(4);
          }
        } catch (error) {
          if (error.data) {
            translate("ERRORS." + error.data.error).then((translation) => {
              state.addToast({ title: "Error", date: new Date(), body: translation });
              state.error = translation;
            }, console.error);
            displayErrorMessage(error.data.error);
          }
          setValidity("sourceUrl", "missing", false);
          throw error;
        }
      }

      // Angular templates evaluate this synchronously, so we keep a
      // {original -> anonymized} cache populated by a debounced batch call to
      // /api/anonymize-preview whenever the PR details, terms, or options
      // change. anonymizePrContent() returns the cached value if known and
      // falls back to the original until the next cycle resolves.
      const _prAnonCache = reactive(new Map());
      let _prSeenContents = new Set();

      function collectPrContents() {
        const out = new Set();
        const d = state.details && state.details.pullRequest;
        if (!d) return out;
        if (typeof d.title === "string") out.add(d.title);
        if (typeof d.body === "string") out.add(d.body);
        if (typeof d.diff === "string") out.add(d.diff);
        const comments =
          d.comments || [];
        for (const c of comments) {
          if (typeof c.author === "string") out.add(c.author);
          if (typeof c.body === "string") out.add(c.body);
        }
        return out;
      }

      const refreshPrPreview = makePreviewBatcher(
        () => {
          const seen = collectPrContents();
          _prSeenContents = seen;
          const list = Array.from(seen);
          if (list.length === 0) return null;
          return { contents: list, options: previewOptions() };
        },
        (data) => {
          if (!data || !Array.isArray(data.contents)) return;
          const seen = Array.from(_prSeenContents);
          const next = new Map();
          for (let i = 0; i < seen.length && i < data.contents.length; i++) {
            next.set(seen[i], data.contents[i]);
          }
          _prAnonCache.clear();
          next.forEach((value, key) => _prAnonCache.set(key, value));
        }
      );

      state.anonymizePrContent = function (content) {
        if (!content) return content;
        if (_prAnonCache.has(content)) return _prAnonCache.get(content);
        if (!_prSeenContents.has(content)) {
          refreshPrPreview();
        }
        return content;
      };

      // ========== GIST LOGIC ==========
      async function getGistDetails() {
        const o = parseGithubUrl(state.sourceUrl);
        try {
          resetValidity();
          const res = await http.get(`/api/gist/source/${o.gistId}`);
          state.details = res.data;
          if (!state.gistId) {
            state.gistId = "gist-" + o.gistId.substring(0, 6) + "-" + generateRandomId(4);
          }
        } catch (error) {
          if (error.data) {
            translate("ERRORS." + error.data.error).then((translation) => {
              state.addToast({ title: "Error", date: new Date(), body: translation });
              state.error = translation;
            }, console.error);
            displayErrorMessage(error.data.error);
          }
          setValidity("sourceUrl", "missing", false);
          throw error;
        }
      }

      const _gistAnonCache = reactive(new Map());
      let _gistSeenContents = new Set();

      function collectGistContents() {
        const out = new Set();
        const d = state.details && state.details.gist;
        if (!d) return out;
        if (typeof d.description === "string") out.add(d.description);
        if (typeof d.ownerLogin === "string") out.add(d.ownerLogin);
        const files = (d.files) || [];
        for (const f of files) {
          if (typeof f.filename === "string") out.add(f.filename);
          if (typeof f.content === "string") out.add(f.content);
        }
        const comments = d.comments || [];
        for (const c of comments) {
          if (typeof c.author === "string") out.add(c.author);
          if (typeof c.body === "string") out.add(c.body);
        }
        return out;
      }

      const refreshGistPreview = makePreviewBatcher(
        () => {
          const seen = collectGistContents();
          _gistSeenContents = seen;
          const list = Array.from(seen);
          if (list.length === 0) return null;
          return { contents: list, options: previewOptions() };
        },
        (data) => {
          if (!data || !Array.isArray(data.contents)) return;
          const seen = Array.from(_gistSeenContents);
          const next = new Map();
          for (let i = 0; i < seen.length && i < data.contents.length; i++) {
            next.set(seen[i], data.contents[i]);
          }
          _gistAnonCache.clear();
          next.forEach((value, key) => _gistAnonCache.set(key, value));
          rebuildPreviewGistFiles();
        }
      );

      state.anonymizeGistContent = function (content) {
        if (!content) return content;
        if (_gistAnonCache.has(content)) return _gistAnonCache.get(content);
        if (!_gistSeenContents.has(content)) {
          refreshGistPreview();
        }
        return content;
      };

      // Precomputed file objects for the preview pane so <gist-file>'s
      // props have a stable reference. Recomputes when the source
      // files change OR when the anonymization cache turns over.
      state.previewGistFiles = [];
      function rebuildPreviewGistFiles() {
        const files =
          (state.details && state.details.gist && state.details.gist.files) || [];
        state.previewGistFiles = files.map((f) => ({
          filename: state.anonymizeGistContent(f.filename),
          content: state.anonymizeGistContent(f.content),
          language: f.language,
        }));
      }
      // _prAnonCache turns over inside refreshGistPreview's applyResult; the
      // simplest signal we have is the digest cycle, so re-derive each digest.
      // Cheap when _gistAnonCache hits.
      state.watch("details.gist.files", rebuildPreviewGistFiles, true);
      state.watch("terms", rebuildPreviewGistFiles);

      // ========== SHARED LOGIC ==========
      function getConference() {
        const conference = state.conference;
        state.conference_data = null;
        if (!conference) return;
        const preserveSavedOptions =
          state.isUpdate && conference === state._originalConference;
        http.get("/api/conferences/" + conference).then(
          (res) => {
            if (state.conference !== conference) return;
            state.conference_data = res.data;
            state.conference_data.startDate = new Date(state.conference_data.startDate);
            state.conference_data.endDate = new Date(state.conference_data.endDate);
            // Conference defaults must not overwrite an existing submission's
            // saved settings when its edit form loads (#791).
            if (preserveSavedOptions) return;
            state.options.expirationDate = new Date(state.conference_data.endDate);
            state.options.expirationMode = "remove";
            state.options.update = state.conference_data.options.update;
            state.options.image = state.conference_data.options.image;
            state.options.pdf = state.conference_data.options.pdf;
            state.options.notebook = state.conference_data.options.notebook;
            state.options.link = state.conference_data.options.link;
          },
          () => {
            if (state.conference === conference) state.conference_data = null;
          }
        );
      }

      function resetValidity() {
        setValidity("repoId", "used", true);
        setValidity("repoId", "format", true);
        setValidity("pullRequestId", "used", true);
        setValidity("pullRequestId", "format", true);
        setValidity("gistId", "used", true);
        setValidity("gistId", "format", true);
        setValidity("sourceUrl", "used", true);
        setValidity("sourceUrl", "missing", true);
        setValidity("sourceUrl", "access", true);
        setValidity("sourceUrl", "github", true);
        setValidity("commit", "exists", true);
        setValidity("conference", "activated", true);
        setValidity("terms", "format", true);
        state.termsRegexWarning = false;
      }

      // Guards against submitting a missing or out-of-range expiration date.
      // When the picked date fails min/max validation AngularJS sets the model
      // to undefined, so we check both the field validity and the model value.
      function expirationDateInvalid() {
        const field = state.anonymize && state.anonymize.expirationDate;
        if (!state.options.expirationDate || (field && field.invalid)) {
          if (field && field.setDirty) field.setDirty();
          state.error = "Please choose a valid expiration date.";
          return true;
        }
        return false;
      }

      function displayErrorMessage(message) {
        const idField =
          state.detectedType === "pr"
            ? "pullRequestId"
            : state.detectedType === "gist"
            ? "gistId"
            : "repoId";
        switch (message) {
          case "repoId_already_used": setValidity(idField, "used", false); break;
          case "invalid_repoId": setValidity(idField, "format", false); break;
          case "options_not_provided": setValidity(idField, "format", false); break;
          case "repo_already_anonymized": setValidity("sourceUrl", "used", false); break;
          case "invalid_terms_format": setValidity("terms", "format", false); break;
          case "repo_not_found": setValidity("sourceUrl", "missing", false); break;
          case "repo_not_accessible": setValidity("sourceUrl", "access", false); break;
          case "commit_not_found": setValidity("commit", "exists", false); break;
          case "conf_not_activated": setValidity("conference", "activated", false); break;
        }
      }

      // ========== CO-AUTHORS ==========
      state.coauthors = state.coauthors || [];
      state.coauthorResults = [];
      state.coauthorError = "";

      state.searchCoauthors = () => {
        const q = (state.coauthorSearch || "").trim();
        state.coauthorError = "";
        if (q.length < 2) {
          state.coauthorResults = [];
          return;
        }
        http.get("/api/user/search/github-users", { params: { q } }).then(
          (res) => {
            const existing = new Set(
              (state.coauthors || []).map((c) => (c.username || "").toLowerCase())
            );
            state.coauthorResults = (res.data || []).filter(
              (u) => !existing.has((u.username || "").toLowerCase())
            );
          },
          () => { state.coauthorResults = []; }
        );
      };

      state.addCoauthor = (u, event) => {
        if (event) event.preventDefault();
        if (!u || !u.username) return;
        http
          .post("/api/repo/" + state.repoId + "/coauthors", {
            username: u.username,
          })
          .then(
            (res) => {
              state.coauthors = res.data || [];
              state.coauthorResults = [];
              state.coauthorSearch = "";
              state.coauthorError = "";
            },
            (err) => {
              const code = (err && err.data && err.data.error) || "unknown_error";
              state.coauthorError = code;
            }
          );
      };

      state.removeCoauthor = (c) => {
        if (!c || !c.username) return;
        if (!confirm("Remove co-author " + c.username + "?")) return;
        http
          .delete(
            "/api/repo/" +
              state.repoId +
              "/coauthors/" +
              encodeURIComponent(c.username)
          )
          .then(
            (res) => { state.coauthors = res.data || []; },
            (err) => {
              const code = (err && err.data && err.data.error) || "unknown_error";
              state.coauthorError = code;
            }
          );
      };

      // Submit: repo
      state.anonymizeRepo = (event) => {
        if (expirationDateInvalid()) return;
        event.target.disabled = true;
        const o = parseGithubUrl(state.sourceUrl);
        const payload = {
          repoId: state.repoId,
          terms: state.terms.trim().split("\n").filter((f) => f),
          connection: state.githubConnection,
          fullName: `${o.owner}/${o.repo}`,
          repository: state.sourceUrl,
          options: state.options,
          source: state.source,
          conference: state.conference,
        };
        if (state.details) payload.options.pageSource = state.details.pageSource;
        resetValidity();
        const url = state.isUpdate ? "/api/repo/" + state.repoId : "/api/repo/";
        http.post(url, payload, { headers: { "Content-Type": "application/json" } }).then(
          () => { window.location.href = "/status/" + state.repoId; },
          (error) => {
            if (error.data) {
              translate("ERRORS." + error.data.error).then((t) => { state.error = t; }, console.error);
              displayErrorMessage(error.data.error);
            }
          }
        ).finally(() => { event.target.disabled = false;  });
      };

      // Submit: Gist
      state.anonymizeGist = (event) => {
        if (expirationDateInvalid()) return;
        event.target.disabled = true;
        const o = parseGithubUrl(state.sourceUrl);
        const payload = {
          gistId: state.gistId,
          terms: state.terms.trim().split("\n").filter((f) => f),
          source: { gistId: o.gistId },
          options: state.options,
          conference: state.conference,
        };
        resetValidity();
        const url = state.isUpdate ? "/api/gist/" + state.gistId : "/api/gist/";
        http.post(url, payload, { headers: { "Content-Type": "application/json" } }).then(
          () => { window.location.href = "/gist/" + state.gistId; },
          (error) => {
            if (error.data) {
              translate("ERRORS." + error.data.error).then((t) => { state.error = t; }, console.error);
              displayErrorMessage(error.data.error);
            }
          }
        ).finally(() => { event.target.disabled = false;  });
      };

      // Submit: PR
      state.anonymizePullRequest = (event) => {
        if (expirationDateInvalid()) return;
        event.target.disabled = true;
        const o = parseGithubUrl(state.sourceUrl);
        const payload = {
          pullRequestId: state.pullRequestId,
          connection: state.githubConnection,
          terms: state.terms.trim().split("\n").filter((f) => f),
          source: { repositoryFullName: `${o.owner}/${o.repo}`, pullRequestId: o.pullRequestId },
          options: state.options,
          conference: state.conference,
        };
        resetValidity();
        const url = state.isUpdate ? "/api/pr/" + state.pullRequestId : "/api/pr/";
        http.post(url, payload, { headers: { "Content-Type": "application/json" } }).then(
          () => { window.location.href = "/pr/" + state.pullRequestId; },
          (error) => {
            if (error.data) {
              translate("ERRORS." + error.data.error).then((t) => { state.error = t; }, console.error);
              displayErrorMessage(error.data.error);
            }
          }
        ).finally(() => { event.target.disabled = false;  });
      };

      state.watch("conference", () => { getConference(); });
      state.watch("terms", () => {
        if (state.detectedType === "repo") anonymizeReadme();
        if (state.detectedType === "pr") refreshPrPreview();
        if (state.detectedType === "gist") refreshGistPreview();
      });
      state.watch("options.image", () => {
        if (state.detectedType === "repo") anonymizeReadme();
        if (state.detectedType === "pr") refreshPrPreview();
        if (state.detectedType === "gist") refreshGistPreview();
      });
      state.watch("options.link", () => {
        if (state.detectedType === "repo") anonymizeReadme();
        if (state.detectedType === "pr") refreshPrPreview();
        if (state.detectedType === "gist") refreshGistPreview();
      });
      state.watch("details", () => {
        if (state.detectedType === "pr") refreshPrPreview();
        if (state.detectedType === "gist") refreshGistPreview();
      }, true);
    };

export const exploreController = function (state, http, location, params, html, promises) {
      const timers = createTimers();
      const listen = createListeners();
      let contentGeneration = 0;
      let destroyed = false;
      state.on("dispose", () => {
        destroyed = true;
        contentGeneration++;
        if (searchCanceller) searchCanceller.resolve();
      });
      state.files = [];
      state.isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
      state.fileSearchQuery = "";
      state.fileSearchResults = null;
      state.fileSearchLoading = false;

      listen(document, "keydown", function (e) {
        if ((e.metaKey || e.ctrlKey) && e.key === "k") {
          e.preventDefault();
          var input = document.querySelector(".tree-search-input");
          if (input) {
            input.focus();
            input.select();
          }
        }
      });
      var searchCanceller = null;
      state.onFileSearchChange = function () {
        // Cancel any in-flight search request
        if (searchCanceller) {
          searchCanceller.resolve();
          searchCanceller = null;
        }
        const query = state.fileSearchQuery;
        if (!query || query.length < 2) {
          state.fileSearchResults = null;
          state.fileSearchLoading = false;
          return;
        }
        state.fileSearchLoading = true;
        const requestCanceller = promises.defer();
        searchCanceller = requestCanceller;
        http.get(
          `/api/repo/${state.repoId}/files/search?q=${encodeURIComponent(query)}`,
          { timeout: requestCanceller.promise }
        ).then(function (res) {
          if (destroyed || searchCanceller !== requestCanceller) return;
          searchCanceller = null;
          state.fileSearchLoading = false;
          // Merge search results into state.files so the tree can render them.
          // Ancestor folders must appear before their children for toArray() to work.
          var existing = {};
          state.files.forEach(function(f) {
            existing[(f.path || "") + "/" + f.name] = true;
          });
          // First pass: collect ancestor folders (shallow to deep)
          var foldersToAdd = [];
          var folderSeen = {};
          for (var i = 0; i < res.data.length; i++) {
            var f = res.data[i];
            if (f.path) {
              var segments = f.path.split("/");
              var acc = "";
              for (var j = 0; j < segments.length; j++) {
                var parent = acc;
                acc = acc ? acc + "/" + segments[j] : segments[j];
                var folderKey = parent + "/" + segments[j];
                if (!existing[folderKey] && !folderSeen[folderKey]) {
                  folderSeen[folderKey] = true;
                  foldersToAdd.push({ name: segments[j], path: parent });
                }
              }
            }
          }
          // Sort folders by depth (shallow first)
          foldersToAdd.sort(function(a, b) {
            return (a.path || "").split("/").length - (b.path || "").split("/").length;
          });
          // Add folders first, then files
          if (foldersToAdd.length > 0) {
            state.files.push.apply(state.files, foldersToAdd);
          }
          var filesToAdd = [];
          for (var k = 0; k < res.data.length; k++) {
            var rf = res.data[k];
            var key = (rf.path || "") + "/" + rf.name;
            if (!existing[key] && rf.size != null) {
              filesToAdd.push(rf);
              existing[key] = true;
            }
          }
          if (filesToAdd.length > 0) {
            state.files.push.apply(state.files, filesToAdd);
          }
          state.fileSearchResults = res.data;
        }, function () {
          if (!destroyed && searchCanceller === requestCanceller) {
            searchCanceller = null;
            state.fileSearchLoading = false;
            state.fileSearchResults = [];
          }
        });
      };
      const extensionModes = {
        yml: "yaml",
        txt: "text",
        py: "python",
        js: "javascript",
        ts: "typescript",
      };
      const textFiles = ["license", "txt"];
      const imageFiles = [
        "png",
        "jpg",
        "jpeg",
        "gif",
        "svg",
        "ico",
        "bmp",
        "tiff",
        "tif",
        "webp",
        "avif",
        "heif",
        "heic",
      ];
      const audioFiles = ["wav", "mp3", "ogg", "wma", "flac", "aac", "m4a"];
      const mediaFiles = [
        "mp4",
        "avi",
        "webm",
        "mov",
        "mpg",
        "mpeg",
        "mkv",
        "flv",
        "wmv",
        "3gp",
        "3g2",
        "m4v",
        "f4v",
        "f4p",
        "f4a",
        "f4b",
      ];

      state.on("routeUpdate", function (event, current) {
        if (state.repoId != params.repoId) return init();
        if ((params.path || "") == state.filePath) {
          return;
        }
        state.filePath = params.path || "";
        state.paths = state.filePath
          .split("/")
          .filter((f) => f && f.trim().length > 0);


        updateContent();

        // #510 — if we navigated into a subdirectory whose file listing
        // hasn't been fetched, lazy-load the parent directories in the
        // background so getSelectedFile() can populate state.file with the
        // right sha for the next interaction. Done after updateContent so
        // the request fires immediately (getContent falls back to sha "0").
        for (let i = 0; i < state.paths.length - 1; i++) {
          const dirPath = i > 0 ? state.paths.slice(0, i).join("/") : "";
          const alreadyLoaded = state.files.some((f) => f.path === dirPath);
          if (!alreadyLoaded) {
            state.getFiles(dirPath);
          }
        }
      });

      function selectFile() {
        if (state.paths[0] != "") {
          return;
        }
        const readmePriority = [
          "readme.md",
          "readme.txt",
          "readme.org",
          "readme.1st",
          "readme",
        ];
        const readmeCandidates = {};
        for (const file of state.files) {
          if (file.name.toLowerCase().indexOf("readme") > -1) {
            readmeCandidates[file.name.toLowerCase()] = file.name;
          }
        }
        let best_match = null;
        for (const p of readmePriority) {
          if (readmeCandidates[p]) {
            best_match = p;
            break;
          }
        }
        if (!best_match && Object.keys(readmeCandidates).length > 0)
          best_match = Object.keys(readmeCandidates)[0];
        if (best_match) {
          let uri = location.url();
          if (uri[uri.length - 1] != "/") {
            uri += "/";
          }

          // redirect to readme
          location.url(
            uri + encodePathForUrl(readmeCandidates[best_match])
          );
        }
      }
      state.fileCounts = null;
      state.getFiles = function (path) {
        const repoId = state.repoId;
        return http.get(
          `/api/repo/${state.repoId}/files/?path=${encodeURIComponent(path)}&v=${state.options.lastUpdateDate}`
        ).then(function (res) {
          if (destroyed || repoId !== state.repoId) return [];
          const normalized = path || "";
          state.files = state.files.filter((f) => f.path !== normalized);
          state.files.push(...res.data);
          return res.data;
        }, function (err) {
          if (destroyed || repoId !== state.repoId) return [];
          state.type = "error";
          state.content = (err && err.data && err.data.error) || "unknown_error";
          state.files = [];
        });
      };
      function fetchFileCounts() {
        const repoId = state.repoId;
        http.get(
          `/api/repo/${state.repoId}/files/counts`
        ).then(function (res) {
          if (destroyed || repoId !== state.repoId) return;
          state.fileCounts = res.data;
        }, function () {
          state.fileCounts = {};
        });
      }

      function getSelectedFile() {
        return state.files.filter(
          (f) =>
            f.name == state.paths[state.paths.length - 1] &&
            f.path == state.paths.slice(0, state.paths.length - 1).join("/")
        )[0];
      }

      var rlCountdownTimer = null;
      state.on("dispose", function () { if (rlCountdownTimer) timers.interval.cancel(rlCountdownTimer); });

      function getOptions(callback) {
        if (destroyed) return;
        const repoId = state.repoId;
        http.get(`/api/repo/${state.repoId}/options`).then(
          (res) => {
            if (destroyed || repoId !== state.repoId) return;
            state.options = res.data;
            if (state.options.url) {
              window.location = state.options.url;
              return;
            }
            if (callback) {
              callback(res.data);
            }
          },
          (err) => {
            if (destroyed || repoId !== state.repoId) return;
            var data = err.data || {};
            if (data.error === "rate_limited" && data.resetAt) {
              state.type = "rate_limited";
              state.rateLimitResetAt = data.resetAt;
              if (rlCountdownTimer) timers.interval.cancel(rlCountdownTimer);
              function rlTick() {
                var remaining = Math.max(0, Math.ceil((state.rateLimitResetAt - Date.now()) / 1000));
                if (remaining <= 0) {
                  state.rateLimitCountdown = "";
                  state.rateLimitResetAt = 0;
                  if (rlCountdownTimer) { timers.interval.cancel(rlCountdownTimer); rlCountdownTimer = null; }
                  getOptions(callback);
                } else {
                  var min = Math.floor(remaining / 60);
                  var sec = remaining % 60;
                  state.rateLimitCountdown = min > 0 ? min + "m " + sec + "s" : sec + "s";
                }

              }
              rlTick();
              rlCountdownTimer = timers.interval(rlTick, 1000);
            } else if (data.error === "repository_not_ready") {
              state.type = "loading";
              timers.timeout(function () { getOptions(callback); }, 3000);
            } else {
              state.type = "error";
              state.content = data.error;
            }
          }
        );
      }

      // Defined as methods rather than inline `showSource = !showSource` in the
      // template: the toolbar and the file view sit in different child scopes,
      // so an inline assignment would shadow the value on one of them instead
      // of updating the controller's.
      state.toggleSource = function () {
        state.showSource = !state.showSource;
      };

      state.toggleAllowScripts = function () {
        state.allowScripts = !state.allowScripts;
      };

      function getMode(extension) {
        if (extensionModes[extension]) {
          return extensionModes[extension];
        }
        return extension;
      }

      function getType(extension) {
        if (extension == "pdf") {
          return "pdf";
        }
        // Rendered as a document in a sandboxed frame rather than as source —
        // see html-doc.js. "html" is reserved for markup we generated
        // ourselves (rendered markdown/org) and inject directly.
        if (extension == "html" || extension == "htm") {
          return "html-doc";
        }
        if (extension == "md") {
          return "md";
        }
        if (extension == "org") {
          return "org";
        }
        if (extension == "ipynb") {
          return "IPython";
        }
        if (textFiles.indexOf(extension) > -1) {
          return "text";
        }
        if (imageFiles.indexOf(extension) > -1) {
          return "image";
        }
        if (mediaFiles.indexOf(extension) > -1) {
          return "media";
        }
        if (audioFiles.indexOf(extension) > -1) {
          return "audio";
        }
        return "code";
      }

      function getContent(path, fileInfo) {
        const generation = contentGeneration;
        if (!path) {
          state.type = "error";
          state.content = "no_file_selected";
          return;
        }
        const originalType = state.type;
        state.type = "loading";
        state.content = "loading";
        // fileInfo can be undefined when the user navigates (e.g. clicks a
        // markdown link into a subdir whose file list hasn't loaded yet) —
        // see #510. Fall back to "0" so the request still goes through; the
        // server returns a fresh ETag on first hit either way.
        const sha = (fileInfo && fileInfo.sha) || "0";
        http
          .get(
            `/api/repo/${state.repoId}/file/${encodePathForUrl(path)}?v=` +
              sha,
            {
              transformResponse: (data) => {
                return data;
              },
            }
          )
          .then(
            (res) => {
              if (destroyed || generation !== contentGeneration) return;
              state.type = originalType;
              state.content = res.data;
              if (state.content == "") {
                state.content = null;
              }

              if (state.type == "md") {
                state.content = renderMD(res.data, location.url() + "/../");
                state.type = "html";
              }
              if (state.type == "org") {
                const content = contentAbs2Relative(res.data);

                const orgParser = new Org.Parser();
                const orgDocument = orgParser.parse(content);
                var orgHTMLDocument = orgDocument.convert(Org.ConverterHTML, {
                  headerOffset: 1,
                  exportFromLineNumber: false,
                  suppressSubScriptHandling: true,
                  suppressAutoLink: false,
                });
                state.content = DOMPurify.sanitize(orgHTMLDocument.toString());
                state.type = "html";
              }
              if (
                state.type == "code" &&
                res.headers("content-type") == "application/octet-stream"
              ) {
                state.type = "binary";
                state.content = "binary";
              }
              timers.timeout(() => {
                Prism.highlightAll();
              }, 50);
            },
            (err) => {
              if (destroyed || generation !== contentGeneration) return;
              state.type = "error";
              state.content = "unknown_error";
              try {
                err.data = JSON.parse(err.data);
                if (err.data.error) {
                  state.content = err.data.error;
                } else {
                  state.content = err.data;
                }
              } catch (ignore) {
                console.log(err);
                if (err.status == -1) {
                  state.content = "request_error";
                } else if (err.status == 502) {
                  // cloudflare error
                  state.content = "unreachable";
                }
              }
            }
          );
      }

      function updateContent() {
        contentGeneration++;
        state.content = "";
        state.file = getSelectedFile();
        let fileVersion = "0";
        if (state.file && state.file.sha) {
          fileVersion = state.file.sha;
        }
        state.url = `/api/repo/${state.repoId}/file/${encodePathForUrl(
          state.filePath
        )}?v=${fileVersion}`;
        // Directory the file lives in, used as the <base> for a rendered HTML
        // document so its relative images/stylesheets still resolve.
        const dirPath = state.filePath.substring(
          0,
          state.filePath.lastIndexOf("/") + 1
        );
        state.fileBaseUrl = `/api/repo/${state.repoId}/file/${
          dirPath ? encodePathForUrl(dirPath) : ""
        }`;
        state.showSource = false;
        // Scripts in a repository's HTML are opt-in, per file — see
        // html-doc.js. Reset on navigation so trust never carries over from
        // one file to the next.
        state.allowScripts = false;

        let extension = state.filePath.toLowerCase();
        const extensionIndex = extension.lastIndexOf(".");
        if (extensionIndex > -1) {
          extension = extension.substring(extensionIndex + 1);
        }

        state.aceOption = {
          readOnly: true,
          useWrapMode: true,
          showGutter: true,
          theme: "chrome",
          useSoftTab: true,
          tabSize: 2,
          fontSize: 15,
          keyBinding: "vscode",
          fullLineSelection: true,
          highlightActiveLine: false,
          highlightGutterLine: false,
          cursor: "hide",
          showInvisibles: false,
          showIndentGuides: true,
          showPrintMargin: false,
          highlightSelectedWord: false,
          enableBehaviours: true,
          fadeFoldWidgets: false,
          mode: getMode(extension),

          onLoad: function (_editor) {
            const Range = ace.require("ace/range").Range;
            let activeLineMarker = null;

            function highlightLines(from, to) {
              if (activeLineMarker !== null) {
                _editor.session.removeMarker(activeLineMarker);
                activeLineMarker = null;
              }
              if (from === null || from === undefined) return;
              activeLineMarker = _editor.session.addMarker(
                new Range(from, 0, to, 1),
                "highlighted-line",
                "fullLine"
              );
            }

            function applyHashFromUrl(scroll) {
              const m = window.location.hash.match(/^#L(\d+)(?:-L(\d+))?/);
              if (!m) {
                highlightLines(null);
                return;
              }
              const from = parseInt(m[1]) - 1;
              const to = m[2] ? parseInt(m[2]) - 1 : from;
              highlightLines(from, to);
              if (scroll) {
                timers.timeout(() => {
                  _editor.scrollToLine(from, true, true, function () {});
                }, 100);
              }
            }

            applyHashFromUrl(true);

            // #392 — clicking a gutter line updates the URL to #L<n> and
            // shift-clicking extends to #L<from>-L<to> so the user can copy
            // a stable link to a specific line. Use replaceState to avoid
            // polluting history with every click.
            let anchorRow = null;
            _editor.on("guttermousedown", function (e) {
              const row = e.getDocumentPosition().row;
              const shift = e.domEvent && e.domEvent.shiftKey;
              let from = row;
              let to = row;
              if (shift && anchorRow !== null) {
                from = Math.min(anchorRow, row);
                to = Math.max(anchorRow, row);
              } else {
                anchorRow = row;
              }
              const hash =
                from === to
                  ? `#L${from + 1}`
                  : `#L${from + 1}-L${to + 1}`;
              const url =
                window.location.pathname + window.location.search + hash;
              window.history.replaceState(null, "", url);
              highlightLines(from, to);
              e.stop();
            });

            listen(window, "hashchange", () => applyHashFromUrl(false));

            _editor.setFontSize(state.aceOption.fontSize);
            _editor.setReadOnly(state.aceOption.readOnly);
            _editor.setKeyboardHandler(state.aceOption.keyBinding);
            _editor.setSelectionStyle(
              state.aceOption.fullLineSelection ? "line" : "text"
            );
            _editor.setOption("displayIndentGuides", true);
            _editor.setHighlightActiveLine(
              state.aceOption.highlightActiveLine
            );
            if (state.aceOption.cursor == "hide") {
              _editor.renderer.$cursorLayer.element.style.display = "none";
            }
            _editor.setHighlightGutterLine(
              state.aceOption.highlightGutterLine
            );
            _editor.setShowInvisibles(state.aceOption.showInvisibles);
            _editor.setDisplayIndentGuides(state.aceOption.showIndentGuides);

            _editor.renderer.setShowPrintMargin(
              state.aceOption.showPrintMargin
            );
            _editor.setHighlightSelectedWord(
              state.aceOption.highlightSelectedWord
            );
            _editor.session.setUseSoftTabs(state.aceOption.useSoftTab);
            _editor.session.setTabSize(state.aceOption.tabSize);
            _editor.setBehavioursEnabled(state.aceOption.enableBehaviours);
            _editor.setFadeFoldWidgets(state.aceOption.fadeFoldWidgets);
          },
        };
        state.on("dark-mode", (event, on) => {
          if (on) {
            state.aceOption.theme = "nord_dark";
          } else {
            state.aceOption.theme = "chrome";
          }
        });
        if (state.isDarkMode) {
          state.aceOption.theme = "nord_dark";
        }
        state.type = getType(extension);

        if (state.type == "pdf") {
          // The viewer streams the file itself from state.url, so fetching
          // the bytes again here only to hold them as a JS string wastes a
          // request and a lot of memory on a large report. Content stays
          // non-null so the Raw/Download actions remain available.
          state.content = "pdf";
          return;
        }

        getContent(state.filePath, state.file);
      }

      function init() {
        contentGeneration++;
        state.files = [];
        state.content = null;
        state.fileCounts = null;
        state.fileSearchQuery = "";
        state.onFileSearchChange();
        state.repoId = params.repoId;
        state.type = "loading";
        state.filePath = params.path || "";
        state.paths = state.filePath.split("/");

        const repoId = state.repoId;
        getOptions(function (options) {
          fetchFileCounts();
          var chain = promises.resolve();
          for (let i = 0; i < state.paths.length; i++) {
            const path = i > 0 ? state.paths.slice(0, i).join("/") : "";
            chain = chain.then(function () {
              return state.getFiles(path);
            }).then(function () {
              if (state.type === "error") {
                return promises.reject("error");
              }
            });
          }
          chain.then(function () {
            if (destroyed || repoId !== state.repoId) return;
            if (state.files.length == 1 && state.files[0].name == "") {
              state.files = [];
              state.type = "empty";
            } else {
              selectFile();
              updateContent();
            }
          });
        });
      }

      init();
    };

export const pullRequestController = function (state, http, location, params, html) {
      async function getOption(callback) {
        http.get(`/api/pr/${state.pullRequestId}/options`).then(
          (res) => {
            state.options = res.data;
            if (state.options.url) {
              // the repository is expired with redirect option
              window.location = state.options.url;
              return;
            }
            if (callback) {
              callback(res.data);
            }
          },
          (err) => {
            state.type = "error";
            state.content = err.data.error;
          }
        );
      }
      async function getPullRequest(callback) {
        http.get(`/api/pr/${state.pullRequestId}/content`).then(
          (res) => {
            state.details = res.data;
            state.tabState = { active: res.data.diff ? "diff" : "comments" };
            if (callback) {
              callback(res.data);
            }
          },
          (err) => {
            state.type = "error";
            state.content = err.data.error;
          }
        );
      }

      function init() {
        state.pullRequestId = params.pullRequestId;
        state.type = "loading";

        getOption((_) => {
          getPullRequest();
        });
      }

      init();
    };

export const gistController = function (state, http, location, params, html) {
      async function getOption(callback) {
        http.get(`/api/gist/${state.gistId}/options`).then(
          (res) => {
            state.options = res.data;
            if (state.options.url) {
              window.location = state.options.url;
              return;
            }
            if (callback) callback(res.data);
          },
          (err) => {
            state.type = "error";
            state.content = err.data.error;
          }
        );
      }
      async function getGist(callback) {
        http.get(`/api/gist/${state.gistId}/content`).then(
          (res) => {
            state.details = res.data;
            // Choose the visible tab after the asynchronous content arrives.
            const hasFiles = res.data && res.data.files && res.data.files.length;
            state.tabState = { active: hasFiles ? "files" : "comments" };
            if (callback) callback(res.data);
          },
          (err) => {
            state.type = "error";
            state.content = err.data.error;
          }
        );
      }

      function init() {
        state.gistId = params.gistId;
        state.type = "loading";
        getOption(() => { getGist(); });
      }

      init();
    };

export const conferencesController = function (state, http, location) {
      state.watch("user.status", () => {
        if (state.user == null) {
          location.url("/");
        }
      });
      if (state.user == null) {
        location.url("/");
      }

      state.conferences = [];
      state.search = "";

      const conferencesPrefsKey = "conferences.filterPrefs";
      const conferencesPrefDefaults = {
        filters: { status: { ready: true, expired: false, removed: false } },
        orderBy: "name",
      };
      const savedConferencesPrefs = loadFilterPrefs(conferencesPrefsKey) || {};
      state.filters = {
        status: Object.assign(
          {},
          conferencesPrefDefaults.filters.status,
          (savedConferencesPrefs.filters && savedConferencesPrefs.filters.status) || {}
        ),
      };
      state.orderBy = savedConferencesPrefs.orderBy || conferencesPrefDefaults.orderBy;

      state.watch("orderBy", () => {
        saveFilterPrefs(conferencesPrefsKey, {
          filters: state.filters,
          orderBy: state.orderBy,
        });
      });
      state.watch(
        "filters",
        () => {
          saveFilterPrefs(conferencesPrefsKey, {
            filters: state.filters,
            orderBy: state.orderBy,
          });
        },
        true
      );

      state.removeConference = function (conf) {
        if (
          confirm(
            `Are you sure that you want to remove the conference ${conf.name}? All the repositories linked to this conference will expire.`
          )
        ) {
          const toast = reactive({
            title: `Removing ${conf.name}...`,
            date: new Date(),
            body: `The conference ${conf.name} is going to be removed.`,
          });
          state.addToast(toast);
          http.delete(`/api/conferences/${conf.conferenceID}`).then(() => {
            toast.title = `${conf.name} is removed.`;
            toast.body = `The conference ${conf.name} is removed.`;
            getConferences();
          });
        }
      };

      function getConferences() {
        http.get("/api/conferences/").then(
          (res) => {
            state.conferences = res.data || [];
          },
          (err) => {
            console.error(err);
          }
        );
      }
      getConferences();

      state.conferenceFilter = (conference) => {
        if (state.filters.status[conference.status] == false) return false;

        if (state.search.trim().length == 0) return true;

        if (conference.name.indexOf(state.search) > -1) return true;
        if (conference.conferenceID.indexOf(state.search) > -1) return true;

        return false;
      };
    };

export const newConferenceController = function (state, http, location, params) {
      state.watch("user.status", () => {
        if (state.user == null) {
          location.url("/");
        }
      });
      if (state.user == null) {
        location.url("/");
      }

      state.plans = [];
      state.editionMode = false;

      function getConference() {
        http
          .get("/api/conferences/" + params.conferenceId)
          .then((res) => {
            state.options = res.data;
            state.options.startDate = new Date(state.options.startDate);
            state.options.endDate = new Date(state.options.endDate);
          });
      }
      if (params.conferenceId) {
        state.editionMode = true;
        getConference();
      }

      function getPlans() {
        http.get("/api/conferences/plans").then((res) => {
          state.plans = res.data;

          state.plan = state.plans.filter(
            (f) => f.id == state.options.plan.planID
          )[0];
        });
      }
      getPlans();
      const start = new Date();
      start.setDate(1);
      start.setMonth(start.getMonth() + 1);
      const end = new Date(start);
      end.setMonth(start.getMonth() + 7, 0);
      state.options = {
        startDate: start,
        endDate: end,
        plan: {
          planID: "free_conference",
        },
        options: {
          link: true,
          image: true,
          pdf: true,
          notebook: true,
          update: true,
          page: true,
        },
      };
      state.plan = null;

      state.watch("options.plan.planID", () => {
        state.plan = state.plans.filter(
          (f) => f.id == state.options.plan.planID
        )[0];
      });

      function resetValidity() {
        state.conference.name.setValidity("required", true);
        state.conference.conferenceID.setValidity("pattern", true);
        state.conference.conferenceID.setValidity("required", true);
        state.conference.conferenceID.setValidity("used", true);
        state.conference.startDate.setValidity("required", true);
        state.conference.startDate.setValidity("invalid", true);
        state.conference.endDate.setValidity("required", true);
        state.conference.endDate.setValidity("invalid", true);
        state.conference.setValidity("error", true);
      }

      function displayErrorMessage(message) {
        switch (message) {
          case "conf_name_missing":
            state.conference.name.setValidity("required", false);
            break;
          case "conf_id_missing":
            state.conference.conferenceID.setValidity("required", false);
            break;
          case "conf_id_format":
            state.conference.conferenceID.setValidity("pattern", false);
            break;
          case "conf_id_used":
            state.conference.conferenceID.setValidity("used", false);
            break;
          case "conf_start_date_missing":
            state.conference.startDate.setValidity("required", false);
            break;
          case "conf_end_date_missing":
            state.conference.endDate.setValidity("required", false);
            break;
          case "conf_start_date_invalid":
            state.conference.startDate.setValidity("invalid", false);
            break;
          case "conf_end_date_invalid":
            state.conference.endDate.setValidity("invalid", false);
            break;
          default:
            state.conference.setValidity("error", false);
            break;
        }
      }

      state.submit = function () {
        const toast = reactive({
          title: `Creating ${state.options.name}...`,
          date: new Date(),
          body: `The conference ${state.options.conferenceID} is in creation.`,
        });
        if (state.editionMode) {
          toast.title = `Updating ${state.options.name}...`;
          toast.body = `The conference '${state.options.conferenceID}' is updating.`;
        }
        state.addToast(toast);
        resetValidity();
        http
          .post(
            "/api/conferences/" +
              (state.editionMode ? state.options.conferenceID : ""),
            state.options
          )
          .then(
            () => {
              if (!state.editionMode) {
                toast.title = `${state.options.name} created`;
                toast.body = `The conference '${state.options.conferenceID}' is created.`;
              } else {
                toast.title = `${state.options.name} updated`;
                toast.body = `The conference '${state.options.conferenceID}' is updated.`;
              }
              location.url("/conference/" + state.options.conferenceID);
            },
            (error) => {
              displayErrorMessage(error.data.error);
              state.removeToast(toast);
            }
          );
      };
    };

export const conferenceController = function (state, http, location, params) {
      state.watch("user.status", () => {
        if (state.user == null) {
          location.url("/");
        }
      });
      if (state.user == null) {
        location.url("/");
      }
      state.conference = null;

      state.search = "";
      state.filters = {
        status: { ready: true, expired: false, removed: false },
      };
      state.orderBy = "-anonymizeDate";

      state.repoFiler = (repo) => {
        if (state.filters.status[repo.status] == false) return false;

        if (state.search.trim().length == 0) return true;

        if (repo.source.fullName.indexOf(state.search) > -1) return true;
        if (repo.repoId.indexOf(state.search) > -1) return true;

        return false;
      };

      function getConference() {
        http
          .get("/api/conferences/" + params.conferenceId)
          .then((res) => {
            state.conference = res.data;
          });
      }
      getConference();
    };


export const connectionsController = function (state, http) {
  state.connections = null;
  state.connectionError = "";
  state.busy = false;
  state.loadConnections = () => http.get("/github/connections").then(res => {
    state.connections = res.data;
  }).catch(error => { state.connectionError = error.data?.error || "Unable to load connections."; });
  state.changeConnection = async (resource, connection, preview) => {
    state.busy = true;
    state.connectionError = "";
    try {
      const result = await http.post("/github/connections/migrate", { type: resource.type, id: resource.id, connection, preview },
        { headers: { "X-CSRF-Token": state.connections.csrf } });
      if (preview) resource.eligible = result.data.eligible;
      else await state.loadConnections();
    } catch (error) { state.connectionError = error.data?.error || "Unable to change connection."; }
    finally { state.busy = false; }
  };
  state.disconnectOAuth = async () => {
    state.busy = true;
    try {
      await http.post("/github/connections/disconnect-oauth", {}, { headers: { "X-CSRF-Token": state.connections.csrf } });
      await state.loadConnections();
    } catch (error) { state.connectionError = error.data?.error || "Unable to disconnect OAuth."; }
    finally { state.busy = false; }
  };
  state.loadConnections();
};
