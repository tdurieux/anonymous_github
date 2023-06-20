angular
  .module("anonymous-github", [
    "ngRoute",
    "ngSanitize",
    "ui.ace",
    "ngPDFViewer",
    "pascalprecht.translate",
    "admin",
  ])
  .config(function ($routeProvider, $locationProvider, $translateProvider) {
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
        controller: "dashboardController",
        title: "Dashboard - Anonymous GitHub",
      })
      .when("/pr-dashboard", {
        templateUrl: "/partials/pr-dashboard.htm",
        controller: "prDashboardController",
        title: "Pull Request Dashboard - Anonymous GitHub",
      })
      .when("/anonymize/:repoId?", {
        templateUrl: "/partials/anonymize.htm",
        controller: "anonymizeController",
        title: "Anonymize - Anonymous GitHub",
      })
      .when("/pull-request-anonymize/:pullRequestId?", {
        templateUrl: "/partials/anonymizePullRequest.htm",
        controller: "anonymizePullRequestController",
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
  })
  .filter("humanFileSize", function () {
    return function humanFileSize(bytes, si = false, dp = 1) {
      const thresh = si ? 1000 : 1024;

      bytes = bytes / 8;

      if (Math.abs(bytes) < thresh) {
        return bytes + "B";
      }

      const units = si
        ? ["kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"]
        : ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"];
      let u = -1;
      const r = 10 ** dp;

      do {
        bytes /= thresh;
        ++u;
      } while (Math.round(Math.abs(bytes) * r) / r >= thresh && u < units.length - 1);

      return bytes.toFixed(dp) + "" + units[u];
    };
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
  .filter("diff", function ($sce) {
    return function (str) {
      if (!str) return str;
      const lines = str.split("\n");
      const o = [];
      for (let i = 1; i < lines.length; i++) {
        lines[i] = lines[i].replace(/</g, "&lt;").replace(/>/g, "&gt;");
        if (lines[i].startsWith("+++")) {
          o.push(`<span class="diff-file">${lines[i]}</span>`);
        } else if (lines[i].startsWith("---")) {
          o.push(`<span class="diff-file">${lines[i]}</span>`);
        } else if (lines[i].startsWith("@@")) {
          o.push(`<span class="diff-lines">${lines[i]}</span>`);
        } else if (lines[i].startsWith("index")) {
          o.push(`<span class="diff-index">${lines[i]}</span>`);
        } else if (lines[i].startsWith("+")) {
          o.push(`<span class="diff-add">${lines[i]}</span>`);
        } else if (lines[i].startsWith("-")) {
          o.push(`<span class="diff-remove">${lines[i]}</span>`);
        } else {
          o.push(`<span class="diff-line">${lines[i]}</span>`);
        }
      }
      return $sce.trustAsHtml(o.join("\n"));
    };
  })
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
            elem.html(renderMD(scope.content, $location.url()));
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

            const toArray = function (obj) {
              const output = [];
              for (let name in obj) {
                if (obj[name].size != null) {
                  // it is a file
                  output.push({
                    name,
                    size: obj[name].size,
                    sha: obj[name].sha,
                  });
                } else {
                  output.push({
                    name,
                    sha: obj[name].sha,
                    child: obj[name],
                  });
                }
              }
              return output;
            };

            const sortFiles = (f1, f2) => {
              const f1d = isDir(f1.child);
              const f2d = isDir(f2.child);
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

            function generate(current, parentPath) {
              const afiles = toArray(current).sort(sortFiles);
              let output = "<ul>";
              for (let f of afiles) {
                let dir = isDir(f.child);
                let name = f.name;
                let size = f.size;
                if (dir) {
                  let test = name;
                  current = toArray(f.child);
                  while (current.length == 1) {
                    test += "/" + current[0].name;
                    size = current[0].size;
                    current = toArray(current[0].child);
                  }
                  name = test;
                  if (current.length == 0) {
                    dir = false;
                  }
                }
                const path = `${parentPath}/${name}`;
                output += `<li class="file ${
                  dir ? "folder" : ""
                }" ng-class="{active: isActive('${path}'), open: opens['${path}']}" title="Size: ${size}">`;
                if (dir) {
                  output += `<a ng-click="openFolder('${path}', $event)">${name}</a>`;
                } else {
                  output += `<a href='/r/${$scope.repoId}${path}'>${name}</a>`;
                }
                if ($scope.opens[path]) {
                  output += generate(f.child, parentPath + "/" + f.name);
                }
                // output += generate(f.child, parentPath + "/" + f.name);
                output + "</li>";
              }
              return output + "</ul>";
            }
            function display() {
              const output = generate($scope.file, "");
              $compile(output)($scope, (clone) => {
                $element.append(clone);
              });
            }

            $scope.$watch("file", (newValue) => {
              if (newValue == null) return;
              if (Array.isArray(newValue)) return;
              if (Object.keys(newValue).length == 0) {
                return $element.html("Empty repository");
              }
              display();
            });

            $scope.isActive = function (name) {
              return $routeParams.path == name.substring(1);
            };

            $scope.openFolder = function (folder, event) {
              $scope.opens[folder] = !$scope.opens[folder];
              if (event.srcElement.nextSibling == null) {
                const folders = folder.substring(1).split("/");
                let current = $scope.file;
                for (let folder of folders) {
                  current = current[folder];
                }
                $compile(generate(current, folder))($scope, (clone) => {
                  angular.element(event.srcElement.parentNode).append(clone);
                });
              }
            };
            const isFile = function (child) {
              return child == null || child.size != null;
            };
            const isDir = function (child) {
              return !isFile(child);
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
        controller: function ($element, $scope, $http) {
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
        controller: function ($scope) {
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
      };
    },
  ])
  .controller("mainController", [
    "$scope",
    "$http",
    "$location",
    function ($scope, $http, $location) {
      $scope.title = "Main";
      $scope.user = { status: "connection" };
      $scope.site_options;

      $scope.toasts = [];

      $scope.removeToast = function (toast) {
        const index = $scope.toasts.indexOf(toast);
        $scope.toasts.splice(index, 1);
      };

      $scope.path = $location.url();
      $scope.paths = $location.path().substring(1).split("/");

      $scope.darkMode = function (on) {
        localStorage.setItem("darkMode", on);
        $scope.isDarkMode = on;
        if (on) {
          $("body").addClass("dark-mode");
        } else {
          $("body").removeClass("dark-mode");
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
  .controller("faqController", [
    "$scope",
    "$http",
    function ($scope, $http) {
      function getSupportedFileTypes() {
        $http.get("/api/supportedTypes").then((res) => {
          $scope.supportedFileTypes = res.data;
        });
      }
      getSupportedFileTypes();
    },
  ])
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
  .controller("dashboardController", [
    "$scope",
    "$http",
    "$location",
    function ($scope, $http, $location) {
      $scope.$on("$routeChangeStart", function () {
        // remove tooltip
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

      $scope.repositories = [];
      $scope.search = "";
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

      function getRepositories() {
        $http.get("/api/user/anonymized_repositories").then(
          (res) => {
            $scope.repositories = res.data;
            for (let repo of $scope.repositories) {
              if (!repo.pageView) {
                repo.pageView = 0;
              }
              if (!repo.lastView) {
                repo.lastView = "";
              }
              repo.options.terms = repo.options.terms.filter((f) => f);
            }
          },
          (err) => {
            console.error(err);
          }
        );
      }
      getRepositories();

      function waitRepoToBeReady(repoId, callback) {
        $http.get("/api/repo/" + repoId).then((res) => {
          for (const repo of $scope.repositories) {
            if (repo.repoId == repoId) {
              repo.status = res.data.status;
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

      $scope.removeRepository = (repo) => {
        if (
          confirm(
            `Are you sure that you want to remove the repository ${repo.repoId}?`
          )
        ) {
          const toast = {
            title: `Removing ${repo.repoId}...`,
            date: new Date(),
            body: `The repository ${repo.repoId} is going to be removed.`,
          };
          $scope.toasts.push(toast);
          $http.delete(`/api/repo/${repo.repoId}`).then(
            () => {
              waitRepoToBeReady(repo.repoId, () => {
                toast.title = `${repo.repoId} is removed.`;
                toast.body = `The repository ${repo.repoId} is removed.`;
                $scope.$apply();
              });
            },
            (error) => {
              toast.title = `Error during the removal of ${repo.repoId}.`;
              toast.body = error.body;

              getRepositories();
            }
          );
        }
      };

      $scope.updateRepository = (repo) => {
        const toast = {
          title: `Refreshing ${repo.repoId}...`,
          date: new Date(),
          body: `The repository ${repo.repoId} is going to be refreshed.`,
        };
        $scope.toasts.push(toast);

        $http.post(`/api/repo/${repo.repoId}/refresh`).then(
          () => {
            waitRepoToBeReady(repo.repoId, () => {
              toast.title = `${repo.repoId} is refreshed.`;
              toast.body = `The repository ${repo.repoId} is refreshed.`;
              $scope.$apply();
            });
          },
          (error) => {
            toast.title = `Error during the refresh of ${repo.repoId}.`;
            toast.body = error.body;

            getRepositories();
          }
        );
      };

      $scope.repoFiler = (repo) => {
        if ($scope.filters.status[repo.status] == false) return false;

        if ($scope.search.trim().length == 0) return true;

        if (repo.source.fullName.indexOf($scope.search) > -1) return true;
        if (repo.repoId.indexOf($scope.search) > -1) return true;

        return false;
      };
    },
  ])
  .controller("prDashboardController", [
    "$scope",
    "$http",
    "$location",
    function ($scope, $http, $location) {
      $scope.$on("$routeChangeStart", function () {
        // remove tooltip
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

      $scope.pullRequests = [];
      $scope.search = "";
      $scope.filters = {
        status: { ready: true, expired: true, removed: false },
      };
      $scope.orderBy = "-anonymizeDate";

      function getPullRequests() {
        $http.get("/api/user/anonymized_pull_requests").then(
          (res) => {
            $scope.pullRequests = res.data;
            for (const pr of $scope.pullRequests) {
              if (!pr.pageView) {
                pr.pageView = 0;
              }
              if (!pr.lastView) {
                pr.lastView = "";
              }
              pr.options.terms = pr.options.terms.filter((f) => f);
            }
          },
          (err) => {
            console.error(err);
          }
        );
      }
      getPullRequests();

      $scope.removePullRequest = (pr) => {
        if (
          confirm(
            `Are you sure that you want to remove the pull request ${pr.pullRequestId}?`
          )
        ) {
          const toast = {
            title: `Removing ${pr.pullRequestId}...`,
            date: new Date(),
            body: `The pull request ${pr.pullRequestId} is going to be removed.`,
          };
          $scope.toasts.push(toast);
          $http.delete(`/api/pr/${pr.pullRequestId}`).then(
            () => {
              toast.title = `${pr.pullRequestId} is removed.`;
              toast.body = `The pull request ${pr.pullRequestId} is removed.`;

              getPullRequests();
            },
            (error) => {
              toast.title = `Error during the removal of ${pr.pullRequestId}.`;
              toast.body = error.body;

              getPullRequests();
            }
          );
        }
      };

      $scope.updatePullRequest = (pr) => {
        const toast = {
          title: `Refreshing ${pr.pullRequestId}...`,
          date: new Date(),
          body: `The pull request ${pr.pullRequestId} is going to be refreshed.`,
        };
        $scope.toasts.push(toast);

        $http.post(`/api/pr/${pr.pullRequestId}/refresh`).then(
          () => {
            toast.title = `${pr.pullRequestId} is refreshed.`;
            toast.body = `The pull request ${pr.pullRequestId} is refreshed.`;
            getPullRequests();
          },
          (error) => {
            toast.title = `Error during the refresh of ${pr.pullRequestId}.`;
            toast.body = error.body;

            getPullRequests();
          }
        );
      };

      $scope.pullRequestFilter = (pr) => {
        if ($scope.filters.status[pr.status] == false) return false;

        if ($scope.search.trim().length == 0) return true;

        if ((pr.source.pullRequestId + "").indexOf($scope.search) > -1)
          return true;
        if (pr.source.repositoryFullName.indexOf($scope.search) > -1)
          return true;
        if (pr.pullRequestId.indexOf($scope.search) > -1) return true;

        return false;
      };
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
      $scope.repoUrl = "";
      $scope.repoId = "";
      $scope.terms = "";
      $scope.defaultTerms = "";
      $scope.branches = [];
      $scope.source = {
        branch: "",
        commit: "",
      };
      $scope.options = {
        expirationMode: "remove",
        expirationDate: new Date(),
        update: false,
        image: true,
        pdf: true,
        notebook: true,
        link: true,
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

      getDefault(() => {
        if ($routeParams.repoId && $routeParams.repoId != "") {
          $scope.isUpdate = true;
          $scope.repoId = $routeParams.repoId;
          $http.get("/api/repo/" + $scope.repoId).then(
            async (res) => {
              $scope.repoUrl = "https://github.com/" + res.data.source.fullName;

              $scope.terms = res.data.options.terms.filter((f) => f).join("\n");
              $scope.source = res.data.source;
              $scope.options = res.data.options;
              $scope.conference = res.data.conference;
              if (res.data.options.expirationDate) {
                $scope.options.expirationDate = new Date(
                  res.data.options.expirationDate
                );
              } else {
                $scope.options.expirationDate = new Date();
                $scope.options.expirationDate.setDate(
                  $scope.options.expirationDate.getDate() + 90
                );
              }

              await getDetails();
              await getReadme();
              anonymize();
              $scope.$apply();
            },
            (err) => {
              $location.url("/404");
            }
          );
          $scope.$watch("anonymize", () => {
            $scope.anonymize.repoId.$$element[0].disabled = true;
            $scope.anonymize.repoUrl.$$element[0].disabled = true;
            $scope.anonymize.repositories.$$element[0].disabled = true;
          });
        }
      });

      $scope.repoSelected = async () => {
        $scope.terms = $scope.defaultTerms;
        $scope.repoId = "";
        $scope.source = {
          type: "GitHubStream",
          branch: "",
          commit: "",
        };

        $scope.anonymize_readme = "";
        $scope.readme = "";
        $scope.html_readme = "";
        $scope.details = null;
        $scope.branches = [];

        try {
          parseGithubUrl($scope.repoUrl);
          $scope.anonymize.repoUrl.$setValidity("github", true);
        } catch (error) {
          $scope.anonymize.repoUrl.$setValidity("github", false);
          return;
        }
        try {
          await getDetails();
          await getReadme();
          anonymize();
        } catch (error) {}
        $scope.$apply();
        $('[data-toggle="tooltip"]').tooltip();
      };
      $('[data-toggle="tooltip"]').tooltip();

      $scope.$watch("options.update", (v) => {
        if (v) {
          $scope.anonymize.commit.$$element[0].disabled = true;
        } else {
          $scope.anonymize.commit.$$element[0].disabled = false;
        }
      });
      $scope.$watch("source.branch", async () => {
        const selected = $scope.branches.filter(
          (f) => f.name == $scope.source.branch
        )[0];
        if ($scope.details && $scope.details.hasPage) {
          $scope.anonymize.page.$$element[0].disabled = false;
          if ($scope.details.pageSource.branch != $scope.source.branch) {
            $scope.anonymize.page.$$element[0].disabled = true;
          }
        }

        if (selected) {
          $scope.source.commit = selected.commit;
          $scope.readme = selected.readme;
          await getReadme();
          anonymize();
          $scope.$apply();
        }
      });

      $scope.getBranches = async (force) => {
        const o = parseGithubUrl($scope.repoUrl);
        const branches = await $http.get(
          `/api/repo/${o.owner}/${o.repo}/branches`,
          { params: { force: force === true ? "1" : "0" } }
        );
        $scope.branches = branches.data;
        if (!$scope.source.branch) {
          $scope.source.branch = $scope.details.defaultBranch;
        }
        const selected = $scope.branches.filter(
          (b) => b.name == $scope.source.branch
        );
        if (selected.length > 0) {
          $scope.source.commit = selected[0].commit;
          $scope.readme = selected[0].readme;
          await getReadme(force);
        }
        $scope.$apply();
      };

      async function getDetails() {
        const o = parseGithubUrl($scope.repoUrl);
        try {
          resetValidity();
          const res = await $http.get(`/api/repo/${o.owner}/${o.repo}/`);
          $scope.details = res.data;
          if (!$scope.repoId) {
            $scope.repoId = $scope.details.repo + "-" + generateRandomId(4);
          }
          await $scope.getBranches();
        } catch (error) {
          console.log("here", error);
          if (error.data) {
            $translate("ERRORS." + error.data.error).then((translation) => {
              const toast = {
                title: `Error when getting repository information`,
                date: new Date(),
                body: `${o.owner}/${o.repo} produice the following error: ${translation}`,
              };
              $scope.toasts.push(toast);
              $scope.error = translation;
            }, console.error);
            displayErrorMessage(error.data.error);
          } else {
            const toast = {
              title: `Error when getting repository information`,
              date: new Date(),
              body: `${o.owner}/${o.repo} produice the following error: ${error.message}`,
            };
            $scope.toasts.push(toast);
          }
          $scope.anonymize.repoUrl.$setValidity("missing", false);
          throw error;
        }
      }

      async function getReadme(force) {
        if ($scope.readme && !force) return $scope.readme;
        const o = parseGithubUrl($scope.repoUrl);
        $http
          .get(`/api/repo/${o.owner}/${o.repo}/readme`, {
            params: {
              force: force === true ? "1" : "0",
              branch: $scope.source.branch,
            },
          })
          .then(
            (res) => {
              $scope.readme = res.data;
            },
            () => {
              $scope.readme = "";
              const toast = {
                title: `README not available...`,
                date: new Date(),
                body: `The README of ${o.owner}/${o.repo} was not found.`,
              };
              $scope.toasts.push(toast);
            }
          );
      }

      function getConference() {
        if (!$scope.conference) return;
        $http.get("/api/conferences/" + $scope.conference).then(
          (res) => {
            $scope.conference_data = res.data;
            $scope.conference_data.startDate = new Date(
              $scope.conference_data.startDate
            );
            $scope.conference_data.endDate = new Date(
              $scope.conference_data.endDate
            );

            $scope.options.expirationDate = new Date(
              $scope.conference_data.endDate
            );
            $scope.options.expirationMode = "remove";

            $scope.options.update = $scope.conference_data.options.update;
            $scope.options.image = $scope.conference_data.options.image;
            $scope.options.pdf = $scope.conference_data.options.pdf;
            $scope.options.notebook = $scope.conference_data.options.notebook;
            $scope.options.link = $scope.conference_data.options.link;
          },
          (err) => {
            $scope.conference_data = null;
          }
        );
      }

      function anonymize() {
        $scope.anonymize.terms.$setValidity("regex", true);
        // check if string has regex characters
        if ($scope.terms && $scope.terms.match(/[-[\]{}()*+?.,\\^$|#]/g)) {
          $scope.anonymize.terms.$setValidity("regex", false);
        }
        const urlRegex =
          /<?\b((https?|ftp|file):\/\/)[-A-Za-z0-9+&@#/%?=~_|!:,.;]+[-A-Za-z0-9+&@#/%=~_|]\b\/?>?/g;
        let content = $scope.readme;

        if (!$scope.options.image) {
          // remove images
          content = content.replace(
            /!\[[^\]]*\]\((?<filename>.*?)(?=\"|\))(?<optionalpart>\".*\")?\)/g,
            ""
          );
        }
        if (!$scope.options.link) {
          content = content.replace(
            urlRegex,
            $scope.site_options.ANONYMIZATION_MASK
          );
        }

        const host = document.location.protocol + "//" + document.location.host;

        content = content.replace(
          new RegExp(
            `\\b${$scope.repoUrl}/blob/${$scope.source.branch}\\b`,
            "gi"
          ),
          `${host}/r/${$scope.repoId}`
        );
        content = content.replace(
          new RegExp(
            `\\b${$scope.repoUrl}/tree/${$scope.source.branch}\\b`,
            "gi"
          ),
          `${host}/r/${$scope.repoId}`
        );
        content = content.replace(
          new RegExp(`\\b${$scope.repoUrl}`, "gi"),
          `${host}/r/${$scope.repoId}`
        );
        const terms = $scope.terms.split("\n");
        for (let i = 0; i < terms.length; i++) {
          let term = terms[i];
          try {
            new RegExp(term, "gi");
          } catch {
            // escape regex characters
            term = term.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&");
          }
          if (term.trim() == "") {
            continue;
          }
          // remove whole url if it contains the term

          content = content.replace(urlRegex, (match) => {
            if (new RegExp(`\\b${term}\\b`, "gi").test(match))
              return $scope.site_options.ANONYMIZATION_MASK + "-" + (i + 1);
            return match;
          });

          // remove the term in the text
          content = content.replace(
            new RegExp(`\\b${term}\\b`, "gi"),
            $scope.site_options.ANONYMIZATION_MASK + "-" + (i + 1)
          );
        }

        $scope.anonymize_readme = content;
        const html = renderMD($scope.anonymize_readme, $location.url());
        $scope.html_readme = $sce.trustAsHtml(html);
        setTimeout(Prism.highlightAll, 150);
      }

      function resetValidity() {
        $scope.anonymize.repoId.$setValidity("used", true);
        $scope.anonymize.repoId.$setValidity("format", true);
        $scope.anonymize.repoUrl.$setValidity("used", true);
        $scope.anonymize.repoUrl.$setValidity("missing", true);
        $scope.anonymize.repoUrl.$setValidity("access", true);
        $scope.anonymize.conference.$setValidity("activated", true);
        $scope.anonymize.terms.$setValidity("format", true);
        $scope.anonymize.terms.$setValidity("regex", true);
      }

      function displayErrorMessage(message) {
        switch (message) {
          case "repoId_already_used":
            $scope.anonymize.repoId.$setValidity("used", false);
            break;
          case "invalid_repoId":
            $scope.anonymize.repoId.$setValidity("format", false);
            break;
          case "options_not_provided":
            $scope.anonymize.repoId.$setValidity("format", false);
            break;
          case "repo_already_anonymized":
            $scope.anonymize.repoUrl.$setValidity("used", false);
            break;
          case "invalid_terms_format":
            $scope.anonymize.terms.$setValidity("format", false);
            break;
          case "invalid_terms_format":
            $scope.anonymize.terms.$setValidity("format", false);
            break;
          case "repo_not_found":
            $scope.anonymize.repoUrl.$setValidity("missing", false);
            break;
          case "repo_not_accessible":
            $scope.anonymize.repoUrl.$setValidity("access", false);
            break;
          case "conf_not_activated":
            $scope.anonymize.conference.$setValidity("activated", false);
            break;
          default:
            $scope.anonymize.$setValidity("error", false);
            break;
        }
      }

      function getRepo() {
        const o = parseGithubUrl($scope.repoUrl);
        $scope.options.pageSource = $scope.details.pageSource;
        return {
          repoId: $scope.repoId,
          terms: $scope.terms
            .trim()
            .split("\n")
            .filter((f) => f),
          fullName: `${o.owner}/${o.repo}`,
          repository: $scope.repoUrl,
          options: $scope.options,
          source: $scope.source,
          conference: $scope.conference,
        };
      }

      async function sendRepo(url) {
        resetValidity();
        const newRepo = getRepo();
        try {
          await $http.post(url, newRepo, {
            headers: { "Content-Type": "application/json" },
          });
          window.location.href = "/status/" + $scope.repoId;
        } catch (error) {
          if (error.data) {
            $translate("ERRORS." + error.data.error).then((translation) => {
              $scope.error = translation;
            }, console.error);
            displayErrorMessage(error.data.error);
          } else {
            console.error(error);
          }
        }
      }

      $scope.anonymizeRepo = (event) => {
        event.target.disabled = true;
        sendRepo("/api/repo/").finally(() => {
          event.target.disabled = false;
          $scope.$apply();
        });
      };

      $scope.updateRepo = async (event) => {
        event.target.disabled = true;
        sendRepo("/api/repo/" + $scope.repoId).finally(() => {
          event.target.disabled = false;
          $scope.$apply();
        });
      };

      $scope.$watch("conference", async (v) => {
        getConference();
      });

      $scope.$watch("source.branch", async (v) => {
        const selected = $scope.branches.filter(
          (f) => f.name == $scope.source.branch
        )[0];
        checkHasPage();

        if (selected) {
          $scope.source.commit = selected.commit;
          $scope.readme = selected.readme;
          await getReadme();
          anonymize();
          $scope.$apply();
        }
      });

      function checkHasPage() {
        if ($scope.details && $scope.details.hasPage) {
          $scope.anonymize.page.$$element[0].disabled = false;
          if ($scope.details.pageSource.branch != $scope.source.branch) {
            $scope.anonymize.page.$$element[0].disabled = true;
          }
        }
      }

      $scope.$watch("terms", anonymize);
      $scope.$watch("options.image", anonymize);
      $scope.$watch("options.link", anonymize);
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
      const mediaFiles = [
        "wav",
        "mp3",
        "ogg",
        "mp4",
        "avi",
        "webm",
        "mov",
        "mpg",
        "wma",
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
        const readmePriority = [
          "readme.md",
          "readme.txt",
          "readme.org",
          "readme.1st",
          "readme",
        ];
        // find current folder
        let currentFolder = $scope.files;
        for (const p of $scope.paths) {
          if (currentFolder[p]) {
            currentFolder = currentFolder[p];
          }
        }
        if (currentFolder.size && Number.isInteger(currentFolder.size)) {
          // a file is already selected
          return;
        }
        const readmeCandidates = {};
        for (const file in currentFolder) {
          if (file.toLowerCase().indexOf("readme") > -1) {
            readmeCandidates[file.toLowerCase()] = file;
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
      function getFiles(callback) {
        $http.get(`/api/repo/${$scope.repoId}/files/`).then(
          (res) => {
            $scope.files = res.data;
            selectFile();
            if (callback) {
              return callback();
            }
          },
          (err) => {
            $scope.type = "error";
            $scope.content = err.data.error;
            $scope.files = null;
          }
        );
      }

      async function getOptions(callback) {
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
        return "code";
      }

      function getContent(path) {
        if (!path) {
          $scope.type = "error";
          $scope.content = "no_file_selected";
          return;
        }
        const originalType = $scope.type;
        $scope.type = "loading";
        $scope.content = "loading";
        $http
          .get(`/api/repo/${$scope.repoId}/file/${path}`, {
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
                  renderMD(res.data, $location.url())
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
        $scope.url = `/api/repo/${$scope.repoId}/file/${$scope.filePath}`;

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
            if (window.location.hash && window.location.hash.match(/^#L\d+/)) {
              let from = 0;
              let to = 0;
              if (window.location.hash.indexOf("-") > -1) {
                const match = window.location.hash.match(/^#L(\d+)-L(\d+)/);
                from = parseInt(match[1]) - 1;
                to = parseInt(match[2]) - 1;
              } else {
                from = parseInt(window.location.hash.substring(2)) - 1;
                to = from;
              }

              const Range = ace.require("ace/range").Range;
              _editor.session.addMarker(
                new Range(from, 0, to, 1),
                "highlighted-line",
                "fullLine"
              );
              setTimeout(() => {
                _editor.scrollToLine(from, true, true, function () {});
              }, 100);
            }

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

        getContent($scope.filePath);
      }

      function init() {
        $scope.repoId = $routeParams.repoId;
        $scope.type = "loading";
        $scope.filePath = $routeParams.path || "";
        $scope.paths = $scope.filePath.split("/");

        getOptions((options) => {
          getFiles(() => {
            updateContent();
          });
        });
      }

      init();
    },
  ])
  .controller("anonymizePullRequestController", [
    "$scope",
    "$http",
    "$sce",
    "$routeParams",
    "$location",
    "$translate",
    function ($scope, $http, $sce, $routeParams, $location, $translate) {
      $scope.pullRequestUrl = "";
      $scope.pullRequestId = "";
      $scope.terms = "";
      $scope.defaultTerms = "";
      $scope.options = {
        expirationMode: "remove",
        expirationDate: new Date(),
        update: false,
        image: true,
        link: true,
        body: true,
        title: true,
        origin: false,
        diff: true,
        comments: true,
        username: true,
        date: true,
      };
      $scope.options.expirationDate.setMonth(
        $scope.options.expirationDate.getMonth() + 4
      );
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

      getDefault(() => {
        if ($routeParams.pullRequestId && $routeParams.pullRequestId != "") {
          $scope.isUpdate = true;
          $scope.pullRequestId = $routeParams.pullRequestId;
          $http.get("/api/pr/" + $scope.pullRequestId).then(
            async (res) => {
              $scope.pullRequestUrl =
                "https://github.com/" +
                res.data.source.repositoryFullName +
                "/pull/" +
                res.data.source.pullRequestId;

              $scope.terms = res.data.options.terms.filter((f) => f).join("\n");
              $scope.source = res.data.source;
              $scope.options = res.data.options;
              $scope.conference = res.data.conference;
              if (res.data.options.expirationDate) {
                $scope.options.expirationDate = new Date(
                  res.data.options.expirationDate
                );
              } else {
                $scope.options.expirationDate = new Date();
                $scope.options.expirationDate.setDate(
                  $scope.options.expirationDate.getDate() + 90
                );
              }

              $scope.details = (
                await $http.get(
                  `/api/pr/${res.data.source.repositoryFullName}/${res.data.source.pullRequestId}`
                )
              ).data;
              $scope.$apply();
            },
            (err) => {
              $location.url("/404");
            }
          );
          $scope.$watch("anonymize", () => {
            $scope.anonymizeForm.pullRequestId.$$element[0].disabled = true;
            $scope.anonymizeForm.pullRequestUrl.$$element[0].disabled = true;
          });
        }
      });

      $scope.pullRequestSelected = async () => {
        $scope.terms = $scope.defaultTerms;
        $scope.pullRequestId = "";
        $scope.source = {};

        try {
          const o = parseGithubUrl($scope.pullRequestUrl);
          if (!o.pullRequestId) {
            $scope.anonymizeForm.pullRequestUrl.$setValidity("github", false);
            return;
          }
          $scope.anonymizeForm.pullRequestUrl.$setValidity("github", true);
        } catch (error) {
          $scope.anonymizeForm.pullRequestUrl.$setValidity("github", false);
          return;
        }
        try {
          await getDetails();
        } catch (error) {}
        $scope.$apply();
        $('[data-toggle="tooltip"]').tooltip();
      };
      $('[data-toggle="tooltip"]').tooltip();

      $scope.$watch("options.update", (v) => {});

      async function getDetails() {
        const o = parseGithubUrl($scope.pullRequestUrl);
        try {
          resetValidity();
          const res = await $http.get(
            `/api/pr/${o.owner}/${o.repo}/${o.pullRequestId}`
          );
          $scope.details = res.data;
          if ($scope.options.origin) {
            $scope.pullRequestId = o.repo + "-" + generateRandomId(4);
          } else {
            $scope.pullRequestId = generateRandomId(4);
          }
        } catch (error) {
          if (error.data) {
            $translate("ERRORS." + error.data.error).then((translation) => {
              $scope.error = translation;
            }, console.error);
            displayErrorMessage(error.data.error);
          }
          $scope.anonymizeForm.pullRequestUrl.$setValidity("missing", false);
          throw error;
        }
      }

      function getConference() {
        if (!$scope.conference) return;
        $http.get("/api/conferences/" + $scope.conference).then(
          (res) => {
            $scope.conference_data = res.data;
            $scope.conference_data.startDate = new Date(
              $scope.conference_data.startDate
            );
            $scope.conference_data.endDate = new Date(
              $scope.conference_data.endDate
            );

            $scope.options.expirationDate = new Date(
              $scope.conference_data.endDate
            );
            $scope.options.expirationMode = "remove";

            $scope.options.update = $scope.conference_data.options.update;
            $scope.options.image = $scope.conference_data.options.image;
            $scope.options.pdf = $scope.conference_data.options.pdf;
            $scope.options.notebook = $scope.conference_data.options.notebook;
            $scope.options.link = $scope.conference_data.options.link;
          },
          (err) => {
            $scope.conference_data = null;
          }
        );
      }

      $scope.anonymize = function (content) {
        const urlRegex =
          /<?\b((https?|ftp|file):\/\/)[-A-Za-z0-9+&@#/%?=~_|!:,.;]+[-A-Za-z0-9+&@#/%=~_|]\b\/?>?/g;

        if (!$scope.options.image) {
          // remove images
          content = content.replace(
            /!\[[^\]]*\]\((?<filename>.*?)(?=\"|\))(?<optionalpart>\".*\")?\)/g,
            ""
          );
        }
        if (!$scope.options.link) {
          content = content.replace(
            urlRegex,
            $scope.site_options.ANONYMIZATION_MASK
          );
        }
        const terms = $scope.terms.split("\n");
        for (let i = 0; i < terms.length; i++) {
          const term = terms[i];
          if (term.trim() == "") {
            continue;
          }
          // remove whole url if it contains the term
          content = content.replace(urlRegex, (match) => {
            if (new RegExp(`\\b${term}\\b`, "gi").test(match))
              return $scope.site_options.ANONYMIZATION_MASK + "-" + (i + 1);
            return match;
          });

          // remove the term in the text
          content = content.replace(
            new RegExp(`\\b${term}\\b`, "gi"),
            $scope.site_options.ANONYMIZATION_MASK + "-" + (i + 1)
          );
        }
        return content;
      };

      function resetValidity() {
        $scope.anonymizeForm.pullRequestId.$setValidity("used", true);
        $scope.anonymizeForm.pullRequestId.$setValidity("format", true);
        $scope.anonymizeForm.pullRequestUrl.$setValidity("used", true);
        $scope.anonymizeForm.pullRequestUrl.$setValidity("missing", true);
        $scope.anonymizeForm.pullRequestUrl.$setValidity("access", true);
        $scope.anonymizeForm.conference.$setValidity("activated", true);
        $scope.anonymizeForm.terms.$setValidity("format", true);
        $scope.anonymizeForm.terms.$setValidity("format", true);
      }

      function displayErrorMessage(message) {
        switch (message) {
          case "repoId_already_used":
            $scope.anonymizeForm.repoId.$setValidity("used", false);
            break;
          case "invalid_repoId":
            $scope.anonymizeForm.repoId.$setValidity("format", false);
            break;
          case "options_not_provided":
            $scope.anonymizeForm.repoId.$setValidity("format", false);
            break;
          case "repo_already_anonymized":
            $scope.anonymizeForm.repoUrl.$setValidity("used", false);
            break;
          case "invalid_terms_format":
            $scope.anonymizeForm.terms.$setValidity("format", false);
            break;
          case "invalid_terms_format":
            $scope.anonymizeForm.terms.$setValidity("format", false);
            break;
          case "repo_not_found":
            $scope.anonymizeForm.repoUrl.$setValidity("missing", false);
            break;
          case "repo_not_accessible":
            $scope.anonymizeForm.repoUrl.$setValidity("access", false);
            break;
          case "conf_not_activated":
            $scope.anonymizeForm.conference.$setValidity("activated", false);
            break;
          default:
            $scope.anonymizeForm.$setValidity("error", false);
            break;
        }
      }

      function getPullRequest() {
        const o = parseGithubUrl($scope.pullRequestUrl);
        return {
          pullRequestId: $scope.pullRequestId,
          terms: $scope.terms
            .trim()
            .split("\n")
            .filter((f) => f),
          source: {
            repositoryFullName: `${o.owner}/${o.repo}`,
            pullRequestId: o.pullRequestId,
          },
          options: $scope.options,
          conference: $scope.conference,
        };
      }

      async function sendPullRequest(url) {
        resetValidity();
        try {
          const newPR = getPullRequest();
          await $http.post(url, newPR, {
            headers: { "Content-Type": "application/json" },
          });
          window.location.href = "/pr/" + $scope.pullRequestId;
        } catch (error) {
          if (error.data) {
            $translate("ERRORS." + error.data.error).then((translation) => {
              $scope.error = translation;
            }, console.error);
            displayErrorMessage(error.data.error);
          } else {
            console.error(error);
          }
        }
      }

      $scope.anonymizePullRequest = (event) => {
        event.target.disabled = true;
        sendPullRequest("/api/pr/").finally(() => {
          event.target.disabled = false;
          $scope.$apply();
        });
      };

      $scope.updatePullRequest = async (event) => {
        event.target.disabled = true;
        sendPullRequest("/api/pr/" + $scope.pullRequestId).finally(() => {
          event.target.disabled = false;
          $scope.$apply();
        });
      };

      $scope.$watch("conference", async (v) => {
        getConference();
      });
    },
  ])
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
          $scope.toasts.push(toast);
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
        $scope.toasts.push(toast);
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
