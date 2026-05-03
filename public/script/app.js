angular
  .module("anonymous-github", [
    "ngRoute",
    "ngSanitize",
    "ui.ace",
    "ngPDFViewer",
    "pascalprecht.translate",
    "admin",
  ])
  .config([
    "$routeProvider",
    "$locationProvider",
    "$translateProvider",
    function ($routeProvider, $locationProvider, $translateProvider) {
      $translateProvider.useStaticFilesLoader({
        prefix: "/i18n/locale-",
        suffix: ".json",
      });

      $translateProvider.preferredLanguage("en");

      $routeProvider
        .when("/", {
          templateUrl: "/partials/home.htm",
          controller: "homeController",
          title: "Anonymous GitHub",
        })
        .when("/dashboard", {
          templateUrl: "/partials/dashboard.htm",
          controller: "unifiedDashboardController",
          title: "Dashboard - Anonymous GitHub",
        })
        .when("/pr-dashboard", {
          redirectTo: "/dashboard",
        })
        .when("/anonymize/:repoId?", {
          templateUrl: "/partials/anonymize.htm",
          controller: "anonymizeController",
          title: "Anonymize - Anonymous GitHub",
        })
        .when("/pull-request-anonymize/:pullRequestId?", {
          templateUrl: "/partials/anonymize.htm",
          controller: "anonymizeController",
          title: "Anonymize - Anonymous GitHub",
        })
        .when("/status/:repoId", {
          templateUrl: "/partials/status.htm",
          controller: "statusController",
          title: "Repository status - Anonymous GitHub",
        })
        .when("/conferences", {
          templateUrl: "/partials/conferences.htm",
          controller: "conferencesController",
          title: "Conferences - Anonymous GitHub",
        })
        .when("/conference/new", {
          templateUrl: "/partials/newConference.htm",
          controller: "newConferenceController",
          title: "Add a conference - Anonymous GitHub",
        })
        .when("/conference/:conferenceId/edit", {
          templateUrl: "/partials/newConference.htm",
          controller: "newConferenceController",
          title: "Edit conference - Anonymous GitHub",
        })
        .when("/conference/:conferenceId", {
          templateUrl: "/partials/conference.htm",
          controller: "conferenceController",
          title: "Conference - Anonymous GitHub",
        })
        .when("/faq", {
          templateUrl: "/partials/faq.htm",
          controller: "faqController",
          title: "FAQ - Anonymous GitHub",
        })
        .when("/profile", {
          templateUrl: "/partials/profile.htm",
          controller: "profileController",
          title: "Profile - Anonymous GitHub",
        })
        .when("/claim", {
          templateUrl: "/partials/claim.htm",
          controller: "claimController",
          title: "Claim repository - Anonymous GitHub",
        })
        .when("/pr/:pullRequestId", {
          templateUrl: "/partials/pullRequest.htm",
          controller: "pullRequestController",
          title: "Anonymized Pull Request - Anonymous GitHub",
          reloadOnUrl: false,
        })
        .when("/r/:repoId/:path*?", {
          templateUrl: "/partials/explorer.htm",
          controller: "exploreController",
          title: "Anonymized Repository - Anonymous GitHub",
          reloadOnUrl: false,
        })
        .when("/repository/:repoId/:path*?", {
          templateUrl: "/partials/explorer.htm",
          controller: "exploreController",
          title: "Anonymized Repository - Anonymous GitHub",
          reloadOnUrl: false,
        })
        .when("/admin/", {
          templateUrl: "/partials/admin/repositories.htm",
          controller: "repositoriesAdminController",
          title: "Repositories Admin - Anonymous GitHub",
        })
        .when("/admin/users", {
          templateUrl: "/partials/admin/users.htm",
          controller: "usersAdminController",
          title: "Users Admin - Anonymous GitHub",
        })
        .when("/admin/users/:username", {
          templateUrl: "/partials/admin/user.htm",
          controller: "userAdminController",
          title: "User Admin - Anonymous GitHub",
        })
        .when("/admin/conferences", {
          templateUrl: "/partials/admin/conferences.htm",
          controller: "conferencesAdminController",
          title: "Conferences Admin - Anonymous GitHub",
        })
        .when("/admin/queues", {
          templateUrl: "/partials/admin/queues.htm",
          controller: "queuesAdminController",
          title: "Queues Admin - Anonymous GitHub",
        })
        .when("/404", {
          templateUrl: "/partials/404.htm",
          title: "Page not found - Anonymous GitHub",
        })
        .otherwise({
          templateUrl: "/partials/404.htm",
          title: "Page not found - Anonymous GitHub",
        });
      $locationProvider.html5Mode(true);
    },
  ])
  .filter("humanFileSize", function () {
    return humanFileSize;
  })
  .filter("humanTime", function () {
    return function humanTime(seconds) {
      if (!seconds) {
        return "never";
      }
      if (seconds instanceof Date)
        seconds = Math.round((Date.now() - seconds) / 1000);
      if (typeof seconds == "string" || typeof seconds == "number")
        seconds = Math.round((Date.now() - new Date(seconds)) / 1000);
      var suffix = seconds < 0 ? "from now" : "ago";

      // more than 2 days ago display Date
      if (Math.abs(seconds) > 2 * 60 * 60 * 24) {
        const now = new Date();
        now.setSeconds(now.getSeconds() - seconds);
        return "on " + now.toLocaleDateString();
      }

      seconds = Math.abs(seconds);

      var times = [
        seconds / 60 / 60 / 24 / 365, // years
        seconds / 60 / 60 / 24 / 30, // months
        seconds / 60 / 60 / 24 / 7, // weeks
        seconds / 60 / 60 / 24, // days
        seconds / 60 / 60, // hours
        seconds / 60, // minutes
        seconds, // seconds
      ];
      var names = ["year", "month", "week", "day", "hour", "minute", "second"];

      for (var i = 0; i < names.length; i++) {
        var time = Math.floor(times[i]);
        var name = names[i];
        if (time > 1) name += "s";

        if (time >= 1) return time + " " + name + " " + suffix;
      }
      return "0 seconds " + suffix;
    };
  })
  .filter("title", function () {
    return function (str) {
      if (!str) return str;

      str = str.toLowerCase();
      var words = str.split(" ");

      var capitalized = words.map(function (word) {
        return word.charAt(0).toUpperCase() + word.substring(1, word.length);
      });
      return capitalized.join(" ");
    };
  })
  .filter("diff", [
    "$sce",
    function ($sce) {
      const esc = (s) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

      function flushFile(out, file) {
        if (!file) return;
        const headerName =
          file.newPath && file.newPath !== "/dev/null"
            ? file.newPath
            : file.oldPath || "";
        const status =
          file.oldPath === "/dev/null"
            ? "added"
            : file.newPath === "/dev/null"
            ? "deleted"
            : file.oldPath && file.newPath && file.oldPath !== file.newPath
            ? "renamed"
            : "modified";
        out.push('<div class="diff-file-block">');
        out.push(
          '<div class="diff-file-header"><span class="diff-file-icon"><i class="far fa-file-code"></i></span>' +
            '<span class="diff-file-name">' +
            esc(headerName) +
            "</span>" +
            '<span class="diff-file-status diff-file-status-' +
            status +
            '">' +
            status +
            "</span></div>"
        );
        if (file.lines.length) {
          out.push('<table class="diff-file-table"><tbody>');
          for (const line of file.lines) {
            out.push(
              '<tr class="diff-row diff-row-' +
                line.kind +
                '">' +
                '<td class="diff-gutter diff-gutter-old">' +
                (line.oldNo || "") +
                "</td>" +
                '<td class="diff-gutter diff-gutter-new">' +
                (line.newNo || "") +
                "</td>" +
                '<td class="diff-sign">' +
                (line.kind === "add"
                  ? "+"
                  : line.kind === "remove"
                  ? "-"
                  : line.kind === "hunk"
                  ? "@"
                  : "") +
                "</td>" +
                '<td class="diff-code">' +
                esc(line.text) +
                "</td>" +
                "</tr>"
            );
          }
          out.push("</tbody></table>");
        }
        out.push("</div>");
      }

      return function (str) {
        if (!str) return str;
        const out = [];
        let file = null;
        let oldNo = 0;
        let newNo = 0;
        const ensureFile = () => {
          if (!file) file = { oldPath: "", newPath: "", lines: [] };
          return file;
        };
        const startNewFileIfNeeded = () => {
          if (file && (file.lines.length || file.oldPath || file.newPath)) {
            flushFile(out, file);
            file = null;
          }
        };
        const lines = str.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i];
          if (ln.startsWith("diff --git")) {
            startNewFileIfNeeded();
            ensureFile();
            continue;
          }
          if (ln.startsWith("--- ")) {
            // New file boundary if the previous file already had lines.
            if (file && file.lines.length) startNewFileIfNeeded();
            ensureFile().oldPath = ln.replace(/^--- (a\/)?/, "").trim();
            continue;
          }
          if (ln.startsWith("+++ ")) {
            ensureFile().newPath = ln.replace(/^\+\+\+ (b\/)?/, "").trim();
            continue;
          }
          if (
            ln.startsWith("index ") ||
            ln.startsWith("similarity index") ||
            ln.startsWith("rename ") ||
            ln.startsWith("new file mode") ||
            ln.startsWith("deleted file mode") ||
            ln.startsWith("Binary files")
          ) {
            continue;
          }
          if (ln.startsWith("@@")) {
            const m = ln.match(/@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
            if (m) {
              oldNo = parseInt(m[1], 10);
              newNo = parseInt(m[2], 10);
            }
            ensureFile().lines.push({ kind: "hunk", oldNo: "", newNo: "", text: ln });
            continue;
          }
          if (!file) continue;
          if (ln.startsWith("+")) {
            file.lines.push({ kind: "add", oldNo: "", newNo: newNo, text: ln.slice(1) });
            newNo++;
          } else if (ln.startsWith("-")) {
            file.lines.push({ kind: "remove", oldNo: oldNo, newNo: "", text: ln.slice(1) });
            oldNo++;
          } else {
            file.lines.push({ kind: "ctx", oldNo: oldNo, newNo: newNo, text: ln.startsWith(" ") ? ln.slice(1) : ln });
            oldNo++;
            newNo++;
          }
        }
        flushFile(out, file);
        return $sce.trustAsHtml(out.join(""));
      };
    },
  ])
  .directive("markdown", [
    "$location",
    function ($location) {
      return {
        restrict: "E",
        scope: {
          terms: "=",
          options: "=",
          content: "=",
        },
        link: function (scope, elem, attrs) {
          function update() {
            elem.html(renderMD(scope.content, $location.url() + "/../"));
          }
          scope.$watch(attrs.terms, update);
          scope.$watch("terms", update);
          scope.$watch("options", update);
          scope.$watch("content", update);
        },
      };
    },
  ])
  .directive("tree", [
    function () {
      return {
        restrict: "E",
        scope: { file: "=", parent: "@" },
        controller: [
          "$element",
          "$scope",
          "$routeParams",
          "$compile",
          function ($element, $scope, $routeParams, $compile) {
            $scope.repoId = document.location.pathname.split("/")[2];

            $scope.opens = {};

            if ($routeParams.path) {
              let accumulatedPath = "";
              $routeParams.path.split("/").forEach((f) => {
                $scope.opens[accumulatedPath + "/" + f] = true;
                accumulatedPath = accumulatedPath + "/" + f;
              });
            }

            const toArray = function (arr) {
              const output = [];
              const keys = { "": { child: output } };
              for (let file of arr) {
                let current = keys[file.path].child;
                let fPath = `${file.path}/${file.name}`;
                if (fPath.startsWith("/")) {
                  fPath = fPath.substring(1);
                }
                if (file.size != null) {
                  // it is a file
                  current.push({
                    name: file.name,
                    size: file.size,
                    sha: file.sha,
                  });
                } else {
                  const dir = {
                    name: file.name,
                    child: [],
                  };
                  keys[fPath] = dir;
                  current.push(dir);
                }
              }
              return output;
            };

            const sortFiles = (f1, f2) => {
              const f1d = !!f1.child;
              const f2d = !!f2.child;
              if (f1d && f2d) {
                return f1.name - f2.name;
              }
              if (f1d) {
                return -1;
              }
              if (f2d) {
                return 1;
              }
              return f1.name - f2.name;
            };

            function isTruncated(folderPath) {
              const truncated =
                ($scope.$parent.options &&
                  $scope.$parent.options.truncatedFolders) ||
                [];
              if (!truncated.length) return false;
              const normalized = folderPath.startsWith("/")
                ? folderPath.substring(1)
                : folderPath;
              return truncated.indexOf(normalized) !== -1;
            }

            function generate(current, parentPath) {
              if (!current) return "";
              current = current.sort(sortFiles);
              const afiles = current;
              let output = "<ul>";
              for (let f of afiles) {
                let dir = !!f.child;
                let name = f.name;
                let size = f.size;
                if (dir) {
                  let test = name;
                  current = f.child;
                  while (current && current.length == 1) {
                    test += "/" + current[0].name;
                    size = current[0].size;
                    current = current[0].child;
                  }
                  name = test;
                  if (size != null && size >= 0) {
                    dir = false;
                  }
                }
                if (size != null) {
                  size = `Size: ${humanFileSize(size || 0)}`;
                } else {
                  size = "";
                }
                const path = `${parentPath}/${name}`;

                const cssClasses = ["file"];
                if (dir) {
                  cssClasses.push("folder");
                }
                if ($scope.opens[path]) {
                  cssClasses.push("open");
                }
                if ($scope.isActive(path)) {
                  cssClasses.push("active");
                }
                const truncated = dir && isTruncated(path);
                if (truncated) {
                  cssClasses.push("truncated");
                }

                output += `<li class="${cssClasses.join(
                  " "
                )}" ng-class="{active: isActive('${path}'), open: opens['${path}']}" title="${size}">`;
                if (dir) {
                  output += `<a ng-click="openFolder('${path}', $event)">${name}</a>`;
                } else {
                  output += `<a href='/r/${$scope.repoId}${path}'>${name}</a>`;
                }
                if (truncated) {
                  output += `<span class="truncated-warning" title="{{ 'WARNINGS.folder_truncated' | translate }}"><i class="fas fa-exclamation-triangle"></i></span>`;
                }
                if ($scope.opens[path] && f.child) {
                  if (f.child.length > 1) {
                    output += generate(f.child, path);
                  } else if (dir) {
                    current = f.child;
                    while (current && current.length == 1) {
                      current = current[0].child;
                    }
                    output += generate(current, path);
                  }
                }
                // output += generate(f.child, parentPath + "/" + f.name);
                output + "</li>";
              }
              return output + "</ul>";
            }
            function display() {
              $element.html("");
              const output = generate(toArray($scope.file).sort(sortFiles), "");
              $compile(output)($scope, (clone) => {
                $element.append(clone);
              });
            }

            $scope.$watch(
              "file",
              (newValue) => {
                if (newValue == null) return;
                if (newValue.length == 0) {
                  return $element.html("Empty repository");
                }
                display();
              },
              true
            );

            $scope.isActive = function (name) {
              return $routeParams.path == name.substring(1);
            };

            $scope.openFolder = async function (folder, event) {
              $scope.opens[folder] = !$scope.opens[folder];
              if (event.srcElement.nextSibling == null) {
                await $scope.$parent.getFiles(folder.substring(1));
                $scope.$apply();
              }
            };
          },
        ],
      };
    },
  ])
  .directive("notebook", [
    function () {
      return {
        restrict: "E",
        scope: { file: "=" },
        controller: [
          "$element",
          "$scope",
          "$http",
          function ($element, $scope, $http) {
            function renderNotebookJSON(json) {
              const notebook = nb.parse(json);
              try {
                $element.html("");
                $element.append(notebook.render());
                Prism.highlightAll();
              } catch (error) {
                $element.html("Unable to render the notebook.");
              }
            }
            function render() {
              if ($scope.$parent.content) {
                try {
                  renderNotebookJSON(JSON.parse($scope.$parent.content));
                } catch (error) {
                  $element.html(
                    "Unable to render the notebook invalid notebook format."
                  );
                }
              } else if ($scope.file) {
                $http
                  .get($scope.file.download_url)
                  .then((res) => renderNotebookJSON(res.data));
              }
            }
            $scope.$watch("file", (v) => {
              render();
            });
            render();
          },
        ],
      };
    },
  ])
  .directive("loc", [
    function () {
      return {
        restrict: "E",
        scope: { stats: "=" },
        template:
          "<div class='lang' ng-repeat='lang in elements' title='{{lang.lang|title}}: {{lang.loc | number}} lines' data-toggle='tooltip' data-placement='bottom'  style='width:{{lang.loc*100/total}}%;background:{{lang.color}};'></div>",
        controller: [
          "$scope",
          function ($scope) {
            function render() {
              $scope.elements = [];
              $scope.total = 0;
              for (let lang in $scope.stats) {
                const loc = $scope.stats[lang].code;
                if (!loc) {
                  continue;
                }
                $scope.total += loc;
                $scope.elements.push({
                  lang,
                  loc,
                  color: langColors[lang],
                });
              }
              setTimeout(() => {
                $('[data-toggle="tooltip"]').tooltip();
              }, 100);
            }

            $scope.$watch("stats", (v) => {
              render();
            });
            render();
          },
        ],
      };
    },
  ])
  .controller("mainController", [
    "$scope",
    "$http",
    "$location",
    "$timeout",
    function ($scope, $http, $location, $timeout) {
      $scope.title = "Main";
      $scope.user = { status: "connection" };
      $scope.site_options;

      $scope.toasts = [];

      $scope.removeToast = function (toast) {
        const index = $scope.toasts.indexOf(toast);
        if (index === -1) return;
        $scope.toasts.splice(index, 1);
      };

      // Auto-dismiss toasts after a fixed delay so they don't pile up across
      // navigations (e.g. the "README not found" toast re-fired every time the
      // edit screen was reopened — see #246). Long-running operations that
      // mutate the toast (remove/refresh) will simply disappear once the
      // delay elapses; users can re-check status from the dashboard.
      $scope.addToast = function (toast) {
        $scope.toasts.push(toast);
        $timeout(function () {
          $scope.removeToast(toast);
        }, 8000);
        return toast;
      };

      $scope.path = $location.url();
      $scope.paths = $location.path().substring(1).split("/");

      $scope.darkMode = function (on) {
        localStorage.setItem("darkMode", on);
        $scope.isDarkMode = on;
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
        $scope.$broadcast("dark-mode", on);
      };

      $scope.darkMode(localStorage.getItem("darkMode") == "true");

      function getUser() {
        $http.get("/api/user").then(
          (res) => {
            if (res) $scope.user = res.data;
          },
          () => {
            $scope.user = null;
          }
        );
      }
      getUser();

      function getOptions() {
        $http.get("/api/options").then(
          (res) => {
            if (res) $scope.site_options = res.data;
          },
          () => {
            $scope.site_options = null;
          }
        );
      }
      getOptions();

      function getMessage() {
        $http.get("/api/message").then(
          (res) => {
            if (res) $scope.generalMessage = res.data;
          },
          () => {
            $scope.generalMessage = null;
          }
        );
      }
      getMessage();

      function changedUrl(_, current) {
        if (current) {
          $scope.title = current.title;
        }
        $scope.path = $location.url();
        $scope.paths = $location.path().substring(1).split("/");
      }

      $scope.$on("$routeChangeSuccess", changedUrl);
      $scope.$on("$routeUpdate", changedUrl);
    },
  ])
  .controller("faqController", ["$scope", "$http", function ($scope, $http) {}])
  .controller("profileController", [
    "$scope",
    "$http",
    function ($scope, $http) {
      $scope.terms = "";
      $scope.options = {
        expirationMode: "remove",
        update: false,
        image: true,
        pdf: true,
        notebook: true,
        loc: true,
        link: true,
      };

      function getDefault() {
        $http.get("/api/user/default").then((res) => {
          const data = res.data;
          if (data.terms) {
            $scope.terms = data.terms.join("\n");
          }
          $scope.option = Object.assign({}, $scope.option, data.options);
        });
      }
      getDefault();

      $scope.saveDefault = () => {
        const params = {
          terms: $scope.terms.trim().split("\n"),
          options: $scope.options,
        };
        $http.post("/api/user/default", params).then(
          () => {
            getDefault();
            $scope.message = "Saved";
          },
          (error) => {
            $translate("ERRORS." + error.data.error).then((translation) => {
              $scope.error = translation;
            }, console.error);
          }
        );
      };
    },
  ])
  .controller("claimController", [
    "$scope",
    "$http",
    "$location",
    function ($scope, $http, $location) {
      $scope.repoId = null;
      $scope.repoUrl = null;
      $scope.claim = () => {
        $http
          .post("/api/repo/claim", {
            repoId: $scope.repoId,
            repoUrl: $scope.repoUrl,
          })
          .then(
            (res) => {
              $location.url("/dashboard");
            },
            (err) => {
              $scope.error = err.data;
              $scope.claimForm.repoUrl.$setValidity("not_found", false);
              $scope.claimForm.repoId.$setValidity("not_found", false);
            }
          );
      };
    },
  ])
  .controller("homeController", [
    "$scope",
    "$http",
    "$location",
    function ($scope, $http, $location) {
      if ($scope.user && !$scope.user.status) {
        $location.url("/dashboard");
      }
      $scope.$watch("user.status", () => {
        if ($scope.user && !$scope.user.status) {
          $location.url("/dashboard");
        }
      });

      function getStat() {
        $http.get("/api/stat/").then((res) => {
          $scope.stat = res.data;
        });
      }
      getStat();
    },
  ])
  .controller("unifiedDashboardController", [
    "$scope",
    "$http",
    "$location",
    function ($scope, $http, $location) {
      $scope.$on("$routeChangeStart", function () {
        $('[data-toggle="tooltip"]').tooltip("dispose");
      });
      $scope.$watch("user.status", () => {
        if ($scope.user == null) {
          $location.url("/");
        }
      });
      if ($scope.user == null) {
        $location.url("/");
      }

      setTimeout(() => {
        $('[data-toggle="tooltip"]').tooltip();
      }, 250);

      $scope.items = [];
      $scope.search = "";
      $scope.typeFilter = "all";
      $scope.filters = {
        status: { ready: true, expired: true, removed: false },
      };
      $scope.orderBy = "-anonymizeDate";

      function getQuota() {
        $http.get("/api/user/quota").then((res) => {
          $scope.quota = res.data;
          $scope.quota.storage.percent = $scope.quota.storage.total
            ? ($scope.quota.storage.used * 100) / $scope.quota.storage.total
            : 100;
          $scope.quota.file.percent = $scope.quota.file.total
            ? ($scope.quota.file.used * 100) / $scope.quota.file.total
            : 100;
          $scope.quota.repository.percent = $scope.quota.repository.total
            ? ($scope.quota.repository.used * 100) /
              $scope.quota.repository.total
            : 100;
        }, console.error);
      }
      getQuota();

      let loadedRepos = null;
      let loadedPRs = null;

      function mergeItems() {
        $scope.items = (loadedRepos || []).concat(loadedPRs || []);
      }

      function loadAll() {
        loadedRepos = null;
        loadedPRs = null;
        $http.get("/api/user/anonymized_repositories").then(
          (res) => {
            loadedRepos = res.data.map((repo) => {
              if (!repo.pageView) repo.pageView = 0;
              if (!repo.lastView) repo.lastView = "";
              repo.options.terms = repo.options.terms.filter((f) => f);
              repo._type = "repo";
              repo._id = repo.repoId;
              repo._name = repo.repoId;
              repo._source = repo.source.fullName;
              repo._editUrl = "/anonymize/" + repo.repoId;
              repo._viewUrl = "/r/" + repo.repoId + "/";
              return repo;
            });
            mergeItems();
          },
          (err) => { console.error(err); }
        );
        $http.get("/api/user/anonymized_pull_requests").then(
          (res2) => {
            loadedPRs = res2.data.map((pr) => {
              if (!pr.pageView) pr.pageView = 0;
              if (!pr.lastView) pr.lastView = "";
              pr.options.terms = pr.options.terms.filter((f) => f);
              pr._type = "pr";
              pr._id = pr.pullRequestId;
              pr._name = pr.pullRequestId;
              pr._source = pr.source.repositoryFullName + "#" + pr.source.pullRequestId;
              pr._editUrl = "/pull-request-anonymize/" + pr.pullRequestId;
              pr._viewUrl = "/pr/" + pr.pullRequestId + "/";
              return pr;
            });
            mergeItems();
          },
          (err) => { console.error(err); }
        );
      }
      loadAll();

      function waitRepoToBeReady(repoId, callback) {
        $http.get("/api/repo/" + repoId).then((res) => {
          for (const item of $scope.items) {
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
          setTimeout(() => waitRepoToBeReady(repoId, callback), 2500);
        });
      }

      $scope.removeItem = (item) => {
        const label = item._type === "repo" ? "repository" : "pull request";
        if (confirm(`Are you sure that you want to remove the ${label} ${item._id}?`)) {
          const toast = {
            title: `Removing ${item._id}...`,
            date: new Date(),
            body: `The ${label} ${item._id} is going to be removed.`,
          };
          $scope.addToast(toast);
          const endpoint = item._type === "repo" ? `/api/repo/${item._id}` : `/api/pr/${item._id}`;
          $http.delete(endpoint).then(
            () => {
              if (item._type === "repo") {
                waitRepoToBeReady(item._id, () => {
                  toast.title = `${item._id} is removed.`;
                  toast.body = `The ${label} ${item._id} is removed.`;
                  $scope.$apply();
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

      $scope.refreshItem = (item) => {
        const label = item._type === "repo" ? "repository" : "pull request";
        const toast = {
          title: `Refreshing ${item._id}...`,
          date: new Date(),
          body: `The ${label} ${item._id} is going to be refreshed.`,
        };
        $scope.addToast(toast);
        const endpoint = item._type === "repo"
          ? `/api/repo/${item._id}/refresh`
          : `/api/pr/${item._id}/refresh`;
        $http.post(endpoint).then(
          () => {
            if (item._type === "repo") {
              waitRepoToBeReady(item._id, () => {
                toast.title = `${item._id} is refreshed.`;
                toast.body = `The ${label} ${item._id} is refreshed.`;
                $scope.$apply();
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

      $scope.itemFilter = (item) => {
        if ($scope.typeFilter !== "all" && item._type !== $scope.typeFilter) return false;
        if ($scope.filters.status[item.status] == false) return false;
        if ($scope.search.trim().length == 0) return true;
        if (item._source && item._source.indexOf($scope.search) > -1) return true;
        if (item._id.indexOf($scope.search) > -1) return true;
        return false;
      };
    },
  ])
  .controller("dashboardController", [
    "$scope",
    "$location",
    function ($scope, $location) {
      $location.url("/dashboard");
    },
  ])
  .controller("prDashboardController", [
    "$scope",
    "$location",
    function ($scope, $location) {
      $location.url("/dashboard");
    },
  ])
  .controller("statusController", [
    "$scope",
    "$http",
    "$routeParams",
    function ($scope, $http, $routeParams) {
      $scope.repoId = $routeParams.repoId;
      $scope.repo = null;
      $scope.progress = 0;
      $scope.getStatus = () => {
        $http
          .get("/api/repo/" + $scope.repoId, {
            repoId: $scope.repoId,
            repoUrl: $scope.repoUrl,
          })
          .then(
            (res) => {
              $scope.repo = res.data;
              if ($scope.repo.status == "ready") {
                $scope.progress = 100;
              } else if ($scope.repo.status == "queue") {
                $scope.progress = 10;
              } else if ($scope.repo.status == "downloaded") {
                $scope.progress = 50;
              } else if ($scope.repo.status == "download") {
                $scope.progress = 25;
              } else if ($scope.repo.status == "preparing") {
                $scope.progress = 25;
              } else if ($scope.repo.status == "anonymizing") {
                $scope.progress = 75;
              }
              if (
                $scope.repo.status != "ready" &&
                $scope.repo.status != "error"
              ) {
                setTimeout($scope.getStatus, 2000);
              }
            },
            (err) => {
              $scope.error = err.data.error;
            }
          );
      };
      $scope.getStatus();
    },
  ])
  .controller("anonymizeController", [
    "$scope",
    "$http",
    "$sce",
    "$routeParams",
    "$location",
    "$translate",
    function ($scope, $http, $sce, $routeParams, $location, $translate) {
      // Unified state
      $scope.sourceUrl = "";
      $scope.detectedType = null; // 'repo' or 'pr'
      $scope.repoId = "";
      $scope.pullRequestId = "";
      $scope.terms = "";
      $scope.defaultTerms = "";
      $scope.branches = [];
      $scope.source = { branch: "", commit: "" };
      $scope.options = {
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
        comments: true,
        username: true,
        date: true,
      };
      $scope.options.expirationDate.setDate(
        $scope.options.expirationDate.getDate() + 90
      );
      $scope.anonymize_readme = "";
      $scope.readme = "";
      $scope.html_readme = "";
      $scope.isUpdate = false;

      function getDefault(cb) {
        $http.get("/api/user/default").then((res) => {
          const data = res.data;
          if (data.terms) {
            $scope.defaultTerms = data.terms.join("\n");
          }
          $scope.options = Object.assign({}, $scope.options, data.options);
          $scope.options.expirationDate = new Date(
            $scope.options.expirationDate
          );
          $scope.options.expirationDate.setDate(
            $scope.options.expirationDate.getDate() + 90
          );
          if (cb) cb();
        });
      }

      // Helper to safely set validity on form fields
      function setValidity(field, key, value) {
        if ($scope.anonymize && $scope.anonymize[field]) {
          $scope.anonymize[field].$setValidity(key, value);
        }
      }

      getDefault(() => {
        // Edit mode: repo
        if ($routeParams.repoId && $routeParams.repoId != "") {
          $scope.isUpdate = true;
          $scope.detectedType = "repo";
          $scope.repoId = $routeParams.repoId;
          $http.get("/api/repo/" + $scope.repoId).then(
            async (res) => {
              $scope.sourceUrl = "https://github.com/" + res.data.source.fullName;
              $scope.terms = res.data.options.terms.filter((f) => f).join("\n");
              $scope.source = res.data.source;
              $scope.options = Object.assign({}, $scope.options, res.data.options);
              $scope.conference = res.data.conference;
              $scope.repositoryID = res.data.source.repositoryID;
              if (res.data.options.expirationDate) {
                $scope.options.expirationDate = new Date(res.data.options.expirationDate);
              }
              await Promise.all([getRepoDetails(), getReadme()]);
              anonymizeReadme();
              $scope.$apply();
            },
            () => { $location.url("/404"); }
          );
          $scope.$watch("anonymize", () => {
            if ($scope.anonymize.repoId) $scope.anonymize.repoId.$$element[0].disabled = true;
            if ($scope.anonymize.sourceUrl) $scope.anonymize.sourceUrl.$$element[0].disabled = true;
          });
        }
        // Edit mode: PR
        if ($routeParams.pullRequestId && $routeParams.pullRequestId != "") {
          $scope.isUpdate = true;
          $scope.detectedType = "pr";
          $scope.pullRequestId = $routeParams.pullRequestId;
          $http.get("/api/pr/" + $scope.pullRequestId).then(
            async (res) => {
              $scope.sourceUrl = "https://github.com/" + res.data.source.repositoryFullName + "/pull/" + res.data.source.pullRequestId;
              $scope.terms = res.data.options.terms.filter((f) => f).join("\n");
              $scope.source = res.data.source;
              $scope.options = Object.assign({}, $scope.options, res.data.options);
              $scope.conference = res.data.conference;
              if (res.data.options.expirationDate) {
                $scope.options.expirationDate = new Date(res.data.options.expirationDate);
              }
              $scope.details = (await $http.get(`/api/pr/${res.data.source.repositoryFullName}/${res.data.source.pullRequestId}`)).data;
              $scope.$apply();
            },
            () => { $location.url("/404"); }
          );
          $scope.$watch("anonymize", () => {
            if ($scope.anonymize.pullRequestId) $scope.anonymize.pullRequestId.$$element[0].disabled = true;
            if ($scope.anonymize.sourceUrl) $scope.anonymize.sourceUrl.$$element[0].disabled = true;
          });
        }
      });

      // URL change handler - auto-detect type
      $scope.urlSelected = async () => {
        $scope.terms = $scope.defaultTerms;
        $scope.repoId = "";
        $scope.pullRequestId = "";
        $scope.details = null;
        $scope.branches = [];
        $scope.source = { type: "GitHubStream", branch: "", commit: "" };
        $scope.anonymize_readme = "";
        $scope.readme = "";
        $scope.html_readme = "";
        $scope.detectedType = null;

        let o;
        try {
          o = parseGithubUrl($scope.sourceUrl);
        } catch (error) {
          setValidity("sourceUrl", "github", false);
          return;
        }
        setValidity("sourceUrl", "github", true);
        try {
          if (o.pullRequestId) {
            $scope.detectedType = "pr";
            $scope.source = { repositoryFullName: o.owner + "/" + o.repo, pullRequestId: o.pullRequestId };
            await getPrDetails();
          } else {
            $scope.detectedType = "repo";
            await Promise.all([getRepoDetails(), getReadme()]);
            anonymizeReadme();
          }
        } catch (error) {
          return;
        }
        $scope.$apply();
        $('[data-toggle="tooltip"]').tooltip();
      };
      $('[data-toggle="tooltip"]').tooltip();

      // ========== REPO LOGIC ==========
      $scope.$watch("options.update", (v) => {
        if ($scope.detectedType !== "repo") return;
        if ($scope.anonymize && $scope.anonymize.commit) {
          $scope.anonymize.commit.$$element[0].disabled = !!v;
        }
      });

      $scope.$watch("source.branch", async () => {
        if ($scope.detectedType !== "repo") return;
        const selected = $scope.branches.filter((f) => f.name == $scope.source.branch)[0];
        if (selected) {
          $scope.source.commit = selected.commit;
          $scope.readme = selected.readme;
          await getReadme();
          anonymizeReadme();
          $scope.$apply();
        }
      });

      $scope.getBranches = async (force) => {
        const o = parseGithubUrl($scope.sourceUrl);
        try {
          const branches = await $http.get(`/api/repo/${o.owner}/${o.repo}/branches`, {
            params: { force: force === true ? "1" : "0", repositoryID: $scope.repositoryID },
          });
          $scope.branches = branches.data;
          $scope.sourceUnreachable = false;
          if (!$scope.source.branch) {
            $scope.source.branch = $scope.details.defaultBranch;
          }
          const selected = $scope.branches.filter((b) => b.name == $scope.source.branch);
          if (selected.length > 0) {
            $scope.source.commit = selected[0].commit;
            $scope.readme = selected[0].readme;
            await getReadme(force);
          }
        } catch (error) {
          $scope.branches = [];
          $scope.sourceUnreachable = error && (error.status === 404 || (error.data && error.data.error === "repo_not_found"));
          const code = (error && error.data && error.data.error) || (error && error.status === 404 ? "repo_not_found" : "unknown_error");
          $translate("ERRORS." + code).then((translation) => {
            $scope.toasts = $scope.toasts || [];
            $scope.addToast({ title: "Error", date: new Date(), body: translation });
            $scope.error = translation;
          }, console.error);
          if (typeof setValidity === "function") {
            setValidity("sourceUrl", "missing", false);
          }
        }
        $scope.$apply();
      };

      async function getRepoDetails() {
        const o = parseGithubUrl($scope.sourceUrl);
        try {
          resetValidity();
          const res = await $http.get(`/api/repo/${o.owner}/${o.repo}/`, {
            params: { repositoryID: $scope.repositoryID },
          });
          $scope.details = res.data;
          if (!$scope.repoId) {
            $scope.repoId = $scope.details.repo + "-" + generateRandomId(4);
          }
          await $scope.getBranches();
        } catch (error) {
          if (error.data) {
            $translate("ERRORS." + error.data.error).then((translation) => {
              $scope.addToast({ title: "Error", date: new Date(), body: translation });
              $scope.error = translation;
            }, console.error);
            displayErrorMessage(error.data.error);
          }
          setValidity("sourceUrl", "missing", false);
          throw error;
        }
      }

      async function getReadme(force) {
        if ($scope.readme && !force) return $scope.readme;
        const o = parseGithubUrl($scope.sourceUrl);
        try {
          const res = await $http.get(`/api/repo/${o.owner}/${o.repo}/readme`, {
            params: { force: force === true ? "1" : "0", branch: $scope.source.branch, repositoryID: $scope.repositoryID },
          });
          $scope.readme = res.data;
        } catch (error) {
          $scope.readme = "";
        }
      }

      function anonymizeReadme() {
        if (!$scope.anonymize || !$scope.anonymize.terms) return;
        setValidity("terms", "regex", true);
        if ($scope.terms && $scope.terms.match(/[-[\]{}()*+?.,\\^$|#]/g)) {
          setValidity("terms", "regex", false);
        }
        const urlRegex = /<?\b((https?|ftp|file):\/\/)[-A-Za-z0-9+&@#/%?=~_|!:,.;]+[-A-Za-z0-9+&@#/%=~_|]\b\/?>?/g;
        let content = $scope.readme;
        if (!$scope.options.image) {
          content = content.replace(/!\[[^\]]*\]\((?<filename>.*?)(?=\"|\))(?<optionalpart>\".*\")?\)/g, "");
        }
        if (!$scope.options.link) {
          content = content.replace(urlRegex, $scope.site_options.ANONYMIZATION_MASK);
        }
        const host = document.location.protocol + "//" + document.location.host;
        content = content.replace(new RegExp(`\\b${$scope.sourceUrl}/blob/${$scope.source.branch}\\b`, "gi"), `${host}/r/${$scope.repoId}`);
        content = content.replace(new RegExp(`\\b${$scope.sourceUrl}/tree/${$scope.source.branch}\\b`, "gi"), `${host}/r/${$scope.repoId}`);
        content = content.replace(new RegExp(`\\b${$scope.sourceUrl}`, "gi"), `${host}/r/${$scope.repoId}`);
        const terms = $scope.terms.split("\n");
        for (let i = 0; i < terms.length; i++) {
          let term = terms[i];
          try { new RegExp(term, "gi"); } catch { term = term.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&"); }
          if (term.trim() == "") continue;
          content = content.replace(urlRegex, (match) => {
            if (new RegExp(`\\b${term}\\b`, "gi").test(match)) return $scope.site_options.ANONYMIZATION_MASK + "-" + (i + 1);
            return match;
          });
          content = content.replace(new RegExp(`\\b${term}\\b`, "gi"), $scope.site_options.ANONYMIZATION_MASK + "-" + (i + 1));
        }
        $scope.anonymize_readme = content;
        const o = parseGithubUrl($scope.sourceUrl);
        const html = renderMD($scope.anonymize_readme, `https://github.com/${o.owner}/${o.repo}/raw/${$scope.source.branch}/`);
        $scope.html_readme = $sce.trustAsHtml(html);
        setTimeout(Prism.highlightAll, 150);
      }

      // ========== PR LOGIC ==========
      async function getPrDetails() {
        const o = parseGithubUrl($scope.sourceUrl);
        try {
          resetValidity();
          const res = await $http.get(`/api/pr/${o.owner}/${o.repo}/${o.pullRequestId}`);
          $scope.details = res.data;
          if (!$scope.pullRequestId) {
            $scope.pullRequestId = o.repo + "-PR" + o.pullRequestId + "-" + generateRandomId(4);
          }
        } catch (error) {
          if (error.data) {
            $translate("ERRORS." + error.data.error).then((translation) => {
              $scope.addToast({ title: "Error", date: new Date(), body: translation });
              $scope.error = translation;
            }, console.error);
            displayErrorMessage(error.data.error);
          }
          setValidity("sourceUrl", "missing", false);
          throw error;
        }
      }

      $scope.anonymizePrContent = function (content) {
        if (!content) return content;
        const urlRegex = /<?\b((https?|ftp|file):\/\/)[-A-Za-z0-9+&@#/%?=~_|!:,.;]+[-A-Za-z0-9+&@#/%=~_|]\b\/?>?/g;
        if (!$scope.options.image) {
          content = content.replace(/!\[[^\]]*\]\((?<filename>.*?)(?=\"|\))(?<optionalpart>\".*\")?\)/g, "");
        }
        if (!$scope.options.link) {
          content = content.replace(urlRegex, $scope.site_options.ANONYMIZATION_MASK);
        }
        const terms = $scope.terms.split("\n");
        for (let i = 0; i < terms.length; i++) {
          let term = terms[i];
          try { new RegExp(term, "gi"); } catch { term = term.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&"); }
          if (term.trim() == "") continue;
          content = content.replace(urlRegex, (match) => {
            if (new RegExp(`\\b${term}\\b`, "gi").test(match)) return $scope.site_options.ANONYMIZATION_MASK + "-" + (i + 1);
            return match;
          });
          content = content.replace(new RegExp(`\\b${term}\\b`, "gi"), $scope.site_options.ANONYMIZATION_MASK + "-" + (i + 1));
        }
        return content;
      };

      // ========== SHARED LOGIC ==========
      function getConference() {
        if (!$scope.conference) return;
        $http.get("/api/conferences/" + $scope.conference).then(
          (res) => {
            $scope.conference_data = res.data;
            $scope.conference_data.startDate = new Date($scope.conference_data.startDate);
            $scope.conference_data.endDate = new Date($scope.conference_data.endDate);
            $scope.options.expirationDate = new Date($scope.conference_data.endDate);
            $scope.options.expirationMode = "remove";
            $scope.options.update = $scope.conference_data.options.update;
            $scope.options.image = $scope.conference_data.options.image;
            $scope.options.pdf = $scope.conference_data.options.pdf;
            $scope.options.notebook = $scope.conference_data.options.notebook;
            $scope.options.link = $scope.conference_data.options.link;
          },
          () => { $scope.conference_data = null; }
        );
      }

      function resetValidity() {
        setValidity("repoId", "used", true);
        setValidity("repoId", "format", true);
        setValidity("pullRequestId", "used", true);
        setValidity("pullRequestId", "format", true);
        setValidity("sourceUrl", "used", true);
        setValidity("sourceUrl", "missing", true);
        setValidity("sourceUrl", "access", true);
        setValidity("sourceUrl", "github", true);
        setValidity("conference", "activated", true);
        setValidity("terms", "format", true);
        setValidity("terms", "regex", true);
      }

      function displayErrorMessage(message) {
        const idField = $scope.detectedType === "pr" ? "pullRequestId" : "repoId";
        switch (message) {
          case "repoId_already_used": setValidity(idField, "used", false); break;
          case "invalid_repoId": setValidity(idField, "format", false); break;
          case "options_not_provided": setValidity(idField, "format", false); break;
          case "repo_already_anonymized": setValidity("sourceUrl", "used", false); break;
          case "invalid_terms_format": setValidity("terms", "format", false); break;
          case "repo_not_found": setValidity("sourceUrl", "missing", false); break;
          case "repo_not_accessible": setValidity("sourceUrl", "access", false); break;
          case "conf_not_activated": setValidity("conference", "activated", false); break;
        }
      }

      // Submit: repo
      $scope.anonymizeRepo = (event) => {
        event.target.disabled = true;
        const o = parseGithubUrl($scope.sourceUrl);
        const payload = {
          repoId: $scope.repoId,
          terms: $scope.terms.trim().split("\n").filter((f) => f),
          fullName: `${o.owner}/${o.repo}`,
          repository: $scope.sourceUrl,
          options: $scope.options,
          source: $scope.source,
          conference: $scope.conference,
        };
        if ($scope.details) payload.options.pageSource = $scope.details.pageSource;
        resetValidity();
        const url = $scope.isUpdate ? "/api/repo/" + $scope.repoId : "/api/repo/";
        $http.post(url, payload, { headers: { "Content-Type": "application/json" } }).then(
          () => { window.location.href = "/status/" + $scope.repoId; },
          (error) => {
            if (error.data) {
              $translate("ERRORS." + error.data.error).then((t) => { $scope.error = t; }, console.error);
              displayErrorMessage(error.data.error);
            }
          }
        ).finally(() => { event.target.disabled = false; $scope.$apply(); });
      };

      // Submit: PR
      $scope.anonymizePullRequest = (event) => {
        event.target.disabled = true;
        const o = parseGithubUrl($scope.sourceUrl);
        const payload = {
          pullRequestId: $scope.pullRequestId,
          terms: $scope.terms.trim().split("\n").filter((f) => f),
          source: { repositoryFullName: `${o.owner}/${o.repo}`, pullRequestId: o.pullRequestId },
          options: $scope.options,
          conference: $scope.conference,
        };
        resetValidity();
        const url = $scope.isUpdate ? "/api/pr/" + $scope.pullRequestId : "/api/pr/";
        $http.post(url, payload, { headers: { "Content-Type": "application/json" } }).then(
          () => { window.location.href = "/pr/" + $scope.pullRequestId; },
          (error) => {
            if (error.data) {
              $translate("ERRORS." + error.data.error).then((t) => { $scope.error = t; }, console.error);
              displayErrorMessage(error.data.error);
            }
          }
        ).finally(() => { event.target.disabled = false; $scope.$apply(); });
      };

      $scope.$watch("conference", () => { getConference(); });
      $scope.$watch("terms", () => { if ($scope.detectedType === "repo") anonymizeReadme(); });
      $scope.$watch("options.image", () => { if ($scope.detectedType === "repo") anonymizeReadme(); });
      $scope.$watch("options.link", () => { if ($scope.detectedType === "repo") anonymizeReadme(); });
    },
  ])
  .controller("exploreController", [
    "$scope",
    "$http",
    "$location",
    "$routeParams",
    "$sce",
    "PDFViewerService",
    function ($scope, $http, $location, $routeParams, $sce, PDFViewerService) {
      $scope.files = [];
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

      $scope.$on("$routeUpdate", function (event, current) {
        if (($routeParams.path || "") == $scope.filePath) {
          return;
        }
        $scope.filePath = $routeParams.path || "";
        $scope.paths = $scope.filePath
          .split("/")
          .filter((f) => f && f.trim().length > 0);

        if ($scope.repoId != $routeParams.repoId) {
          return init();
        }

        updateContent();
      });

      function selectFile() {
        if ($scope.paths[0] != "") {
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
        for (const file of $scope.files) {
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
          let uri = $location.url();
          if (uri[uri.length - 1] != "/") {
            uri += "/";
          }

          // redirect to readme
          $location.url(uri + readmeCandidates[best_match]);
        }
      }
      $scope.getFiles = async function (path) {
        try {
          const res = await $http.get(
            `/api/repo/${$scope.repoId}/files/?path=${encodeURIComponent(path)}&v=${$scope.options.lastUpdateDate}`
          );
          $scope.files.push(...res.data);
          return res.data;
        } catch (err) {
          $scope.type = "error";
          $scope.content = err.data.error;
          $scope.files = [];
        }
      };

      function getSelectedFile() {
        return $scope.files.filter(
          (f) =>
            f.name == $scope.paths[$scope.paths.length - 1] &&
            f.path == $scope.paths.slice(0, $scope.paths.length - 1).join("/")
        )[0];
      }

      function getOptions(callback) {
        $http.get(`/api/repo/${$scope.repoId}/options`).then(
          (res) => {
            $scope.options = res.data;
            if ($scope.options.url) {
              // the repository is expired with redirect option
              window.location = $scope.options.url;
              return;
            }
            if (callback) {
              callback(res.data);
            }
          },
          (err) => {
            $scope.type = "error";
            $scope.content = err.data.error;
          }
        );
      }

      function getMode(extension) {
        if (extensionModes[extension]) {
          return extensionModes[extension];
        }
        return extension;
      }

      function getType(extension) {
        if (extension == "pdf") {
          $scope.instance = PDFViewerService.Instance("viewer");
          return "pdf";
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
        if (!path) {
          $scope.type = "error";
          $scope.content = "no_file_selected";
          return;
        }
        const originalType = $scope.type;
        $scope.type = "loading";
        $scope.content = "loading";
        $http
          .get(`/api/repo/${$scope.repoId}/file/${path}?v=` + fileInfo.sha, {
            transformResponse: (data) => {
              return data;
            },
          })
          .then(
            (res) => {
              $scope.type = originalType;
              $scope.content = res.data;
              if ($scope.content == "") {
                $scope.content = null;
              }

              if ($scope.type == "md") {
                $scope.content = $sce.trustAsHtml(
                  renderMD(res.data, $location.url() + "/../")
                );
                $scope.type = "html";
              }
              if ($scope.type == "org") {
                const content = contentAbs2Relative(res.data);

                const orgParser = new Org.Parser();
                const orgDocument = orgParser.parse(content);
                var orgHTMLDocument = orgDocument.convert(Org.ConverterHTML, {
                  headerOffset: 1,
                  exportFromLineNumber: false,
                  suppressSubScriptHandling: true,
                  suppressAutoLink: false,
                });
                $scope.content = $sce.trustAsHtml(orgHTMLDocument.toString());
                $scope.type = "html";
              }
              if (
                $scope.type == "code" &&
                res.headers("content-type") == "application/octet-stream"
              ) {
                $scope.type = "binary";
                $scope.content = "binary";
              }
              setTimeout(() => {
                Prism.highlightAll();
              }, 50);
            },
            (err) => {
              $scope.type = "error";
              $scope.content = "unknown_error";
              try {
                err.data = JSON.parse(err.data);
                if (err.data.error) {
                  $scope.content = err.data.error;
                } else {
                  $scope.content = err.data;
                }
              } catch (ignore) {
                console.log(err);
                if (err.status == -1) {
                  $scope.content = "request_error";
                } else if (err.status == 502) {
                  // cloudflare error
                  $scope.content = "unreachable";
                }
              }
            }
          );
      }

      function updateContent() {
        $scope.content = "";
        $scope.file = getSelectedFile();
        let fileVersion = "0";
        if ($scope.file && $scope.file.sha) {
          fileVersion = $scope.file.sha;
        }
        $scope.url = `/api/repo/${$scope.repoId}/file/${$scope.filePath}?v=${fileVersion}`;

        let extension = $scope.filePath.toLowerCase();
        const extensionIndex = extension.lastIndexOf(".");
        if (extensionIndex > -1) {
          extension = extension.substring(extensionIndex + 1);
        }

        $scope.aceOption = {
          readOnly: true,
          useWrapMode: true,
          showGutter: true,
          theme: "chrome",
          useSoftTab: true,
          showPrintMargin: true,
          tabSize: 2,
          highlightSelectedWord: true,
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
                setTimeout(() => {
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

            window.addEventListener("hashchange", () => applyHashFromUrl(false));

            _editor.setFontSize($scope.aceOption.fontSize);
            _editor.setReadOnly($scope.aceOption.readOnly);
            _editor.setKeyboardHandler($scope.aceOption.keyBinding);
            _editor.setSelectionStyle(
              $scope.aceOption.fullLineSelection ? "line" : "text"
            );
            _editor.setOption("displayIndentGuides", true);
            _editor.setHighlightActiveLine(
              $scope.aceOption.highlightActiveLine
            );
            if ($scope.aceOption.cursor == "hide") {
              _editor.renderer.$cursorLayer.element.style.display = "none";
            }
            _editor.setHighlightGutterLine(
              $scope.aceOption.highlightGutterLine
            );
            _editor.setShowInvisibles($scope.aceOption.showInvisibles);
            _editor.setDisplayIndentGuides($scope.aceOption.showIndentGuides);

            _editor.renderer.setShowPrintMargin(
              $scope.aceOption.showPrintMargin
            );
            _editor.setHighlightSelectedWord(
              $scope.aceOption.highlightSelectedWord
            );
            _editor.session.setUseSoftTabs($scope.aceOption.useSoftTab);
            _editor.session.setTabSize($scope.aceOption.tabSize);
            _editor.setBehavioursEnabled($scope.aceOption.enableBehaviours);
            _editor.setFadeFoldWidgets($scope.aceOption.fadeFoldWidgets);
          },
        };
        $scope.$on("dark-mode", (event, on) => {
          if (on) {
            $scope.aceOption.theme = "nord_dark";
          } else {
            $scope.aceOption.theme = "chrome";
          }
        });
        if ($scope.isDarkMode) {
          $scope.aceOption.theme = "nord_dark";
        }
        $scope.type = getType(extension);

        getContent($scope.filePath, $scope.file);
      }

      function init() {
        $scope.repoId = $routeParams.repoId;
        $scope.type = "loading";
        $scope.filePath = $routeParams.path || "";
        $scope.paths = $scope.filePath.split("/");

        getOptions(async (options) => {
          for (let i = 0; i < $scope.paths.length; i++) {
            const path = i > 0 ? $scope.paths.slice(0, i).join("/") : "";
            await $scope.getFiles(path);
          }
          if ($scope.files.length == 1 && $scope.files[0].name == "") {
            $scope.files = [];
            $scope.type = "empty";
            $scope.$apply();
          } else {
            $scope.$apply(() => {
              selectFile();
              updateContent();
            });
          }
        });
      }

      init();
    },
  ])
  // anonymizePullRequestController removed - unified into anonymizeController
  .controller("pullRequestController", [
    "$scope",
    "$http",
    "$location",
    "$routeParams",
    "$sce",
    function ($scope, $http, $location, $routeParams, $sce) {
      async function getOption(callback) {
        $http.get(`/api/pr/${$scope.pullRequestId}/options`).then(
          (res) => {
            $scope.options = res.data;
            if ($scope.options.url) {
              // the repository is expired with redirect option
              window.location = $scope.options.url;
              return;
            }
            if (callback) {
              callback(res.data);
            }
          },
          (err) => {
            $scope.type = "error";
            $scope.content = err.data.error;
          }
        );
      }
      async function getPullRequest(callback) {
        $http.get(`/api/pr/${$scope.pullRequestId}/content`).then(
          (res) => {
            $scope.details = res.data;
            if (callback) {
              callback(res.data);
            }
          },
          (err) => {
            $scope.type = "error";
            $scope.content = err.data.error;
          }
        );
      }

      function init() {
        $scope.pullRequestId = $routeParams.pullRequestId;
        $scope.type = "loading";

        getOption((_) => {
          getPullRequest();
        });
      }

      init();
    },
  ])
  .controller("conferencesController", [
    "$scope",
    "$http",
    "$location",
    function ($scope, $http, $location) {
      $scope.$watch("user.status", () => {
        if ($scope.user == null) {
          $location.url("/");
        }
      });
      if ($scope.user == null) {
        $location.url("/");
      }

      $scope.conferences = [];
      $scope.search = "";
      $scope.filters = {
        status: { ready: true, expired: false, removed: false },
      };
      $scope.orderBy = "name";

      $scope.removeConference = function (conf) {
        if (
          confirm(
            `Are you sure that you want to remove the conference ${conf.name}? All the repositories linked to this conference will expire.`
          )
        ) {
          const toast = {
            title: `Removing ${conf.name}...`,
            date: new Date(),
            body: `The conference ${conf.name} is going to be removed.`,
          };
          $scope.addToast(toast);
          $http.delete(`/api/conferences/${conf.conferenceID}`).then(() => {
            toast.title = `${conf.name} is removed.`;
            toast.body = `The conference ${conf.name} is removed.`;
            getConferences();
          });
        }
      };

      function getConferences() {
        $http.get("/api/conferences/").then(
          (res) => {
            $scope.conferences = res.data || [];
          },
          (err) => {
            console.error(err);
          }
        );
      }
      getConferences();

      $scope.conferenceFilter = (conference) => {
        if ($scope.filters.status[conference.status] == false) return false;

        if ($scope.search.trim().length == 0) return true;

        if (conference.name.indexOf($scope.search) > -1) return true;
        if (conference.conferenceID.indexOf($scope.search) > -1) return true;

        return false;
      };
    },
  ])
  .controller("newConferenceController", [
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

      $scope.plans = [];
      $scope.editionMode = false;

      function getConference() {
        $http
          .get("/api/conferences/" + $routeParams.conferenceId)
          .then((res) => {
            $scope.options = res.data;
            $scope.options.startDate = new Date($scope.options.startDate);
            $scope.options.endDate = new Date($scope.options.endDate);
          });
      }
      if ($routeParams.conferenceId) {
        $scope.editionMode = true;
        getConference();
      }

      function getPlans() {
        $http.get("/api/conferences/plans").then((res) => {
          $scope.plans = res.data;

          $scope.plan = $scope.plans.filter(
            (f) => f.id == $scope.options.plan.planID
          )[0];
        });
      }
      getPlans();
      const start = new Date();
      start.setDate(1);
      start.setMonth(start.getMonth() + 1);
      const end = new Date();
      end.setMonth(start.getMonth() + 7, 0);
      $scope.options = {
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
      $scope.plan = null;

      $scope.$watch("options.plan.planID", () => {
        $scope.plan = $scope.plans.filter(
          (f) => f.id == $scope.options.plan.planID
        )[0];
      });

      function resetValidity() {
        $scope.conference.name.$setValidity("required", true);
        $scope.conference.conferenceID.$setValidity("pattern", true);
        $scope.conference.conferenceID.$setValidity("required", true);
        $scope.conference.conferenceID.$setValidity("used", true);
        $scope.conference.startDate.$setValidity("required", true);
        $scope.conference.startDate.$setValidity("invalid", true);
        $scope.conference.endDate.$setValidity("required", true);
        $scope.conference.endDate.$setValidity("invalid", true);
        $scope.conference.$setValidity("error", true);
      }

      function displayErrorMessage(message) {
        switch (message) {
          case "conf_name_missing":
            $scope.conference.name.$setValidity("required", false);
            break;
          case "conf_id_missing":
            $scope.conference.conferenceID.$setValidity("required", false);
            break;
          case "conf_id_format":
            $scope.conference.conferenceID.$setValidity("pattern", false);
            break;
          case "conf_id_used":
            $scope.conference.conferenceID.$setValidity("used", false);
            break;
          case "conf_start_date_missing":
            $scope.conference.startDate.$setValidity("required", false);
            break;
          case "conf_end_date_missing":
            $scope.conference.endDate.$setValidity("required", false);
            break;
          case "conf_start_date_invalid":
            $scope.conference.startDate.$setValidity("invalid", false);
            break;
          case "conf_end_date_invalid":
            $scope.conference.endDate.$setValidity("invalid", false);
            break;
          default:
            $scope.conference.$setValidity("error", false);
            break;
        }
      }

      $scope.submit = function () {
        const toast = {
          title: `Creating ${$scope.options.name}...`,
          date: new Date(),
          body: `The conference ${$scope.options.conferenceID} is in creation.`,
        };
        if ($scope.editionMode) {
          toast.title = `Updating ${$scope.options.name}...`;
          toast.body = `The conference '${$scope.options.conferenceID}' is updating.`;
        }
        $scope.addToast(toast);
        resetValidity();
        $http
          .post(
            "/api/conferences/" +
              ($scope.editionMode ? $scope.options.conferenceID : ""),
            $scope.options
          )
          .then(
            () => {
              if (!$scope.editionMode) {
                toast.title = `${$scope.options.name} created`;
                toast.body = `The conference '${$scope.options.conferenceID}' is created.`;
              } else {
                toast.title = `${$scope.options.name} updated`;
                toast.body = `The conference '${$scope.options.conferenceID}' is updated.`;
              }
              $location.url("/conference/" + $scope.options.conferenceID);
            },
            (error) => {
              displayErrorMessage(error.data.error);
              $scope.removeToast(toast);
            }
          );
      };
    },
  ])
  .controller("conferenceController", [
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
      $scope.conference = null;

      $scope.search = "";
      $scope.filters = {
        status: { ready: true, expired: false, removed: false },
      };
      $scope.orderBy = "-anonymizeDate";

      $scope.repoFiler = (repo) => {
        if ($scope.filters.status[repo.status] == false) return false;

        if ($scope.search.trim().length == 0) return true;

        if (repo.source.fullName.indexOf($scope.search) > -1) return true;
        if (repo.repoId.indexOf($scope.search) > -1) return true;

        return false;
      };

      function getConference() {
        $http
          .get("/api/conferences/" + $routeParams.conferenceId)
          .then((res) => {
            $scope.conference = res.data;
          });
      }
      getConference();
    },
  ]);
