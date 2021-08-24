angular
  .module("anonymous-github", [
    "ngRoute",
    "ngSanitize",
    "ui.ace",
    "ngPDFViewer",
    "pascalprecht.translate",
    "angular-google-analytics",
  ])
  .config(function (
    $routeProvider,
    $locationProvider,
    $translateProvider,
    AnalyticsProvider
  ) {
    AnalyticsProvider.setAccount("UA-5954162-28");

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
      .when("/anonymize/:repoId?", {
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
  .run(["Analytics", function (Analytics) {}])
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
      if (typeof seconds == "string")
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
          function render() {
            if (!$scope.file) return;
            $http.get($scope.file).then((res) => {
              var notebook = nb.parse(res.data);
              try {
                var rendered = notebook.render();
                $element.append(rendered);
                Prism.highlightAll();
              } catch (error) {
                $element.html("Unable to render the notebook.");
              }
            });
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
        $scope.toasts = $scope.toasts.splice(index, index);
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
        status: { ready: true, expired: true, removed: true },
      };
      $scope.orderBy = "-anonymizeDate";

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

      function getQuota() {
        $http.get("/api/user/quota").then((res) => {
          $scope.quota = res.data;
        }, console.error);
      }
      // getQuota();

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
          $http.delete(`/api/repo/${repo.repoId}`).then(() => {
            toast.title = `${repo.repoId} is removed.`;
            toast.body = `The repository ${repo.repoId} is removed.`;
            getRepositories();
          });
        }
      };

      $scope.updateRepository = (repo) => {
        const toast = {
          title: `Refreshing ${repo.repoId}...`,
          date: new Date(),
          body: `The repository ${repo.repoId} is going to be removed.`,
        };
        $scope.toasts.push(toast);
        
        $http.post(`/api/repo/${repo.repoId}/refresh`).then(() => {
          toast.title = `${repo.repoId} is refreshed.`;
          toast.body = `The repository ${repo.repoId} is refreshed.`;

          getRepositories();
        });
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
              } else if ($scope.repo.status == "downloading") {
                $scope.progress = 25;
              } else if ($scope.repo.status == "preparing") {
                $scope.progress = 25;
              } else if ($scope.repo.status == "anonymizing") {
                $scope.progress = 75;
              }
              if ($scope.repo.status != "ready") {
                setTimeout($scope.getStatus, 1000);
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
      $scope.repositories = [];
      $scope.source = {
        type: "GitHubDownload",
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

              $scope.details = (
                await $http.get(`/api/repo/${res.data.source.fullName}/`)
              ).data;

              await $scope.getBranches();
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

      $scope.getRepositories = (force) => {
        $http
          .get("/api/user/all_repositories", {
            params: { force: force === true ? "1" : "0" },
          })
          .then((res) => {
            $scope.repositories = res.data;
          });
      };
      $scope.getRepositories();

      $scope.repoSelected = async () => {
        $scope.terms = $scope.defaultTerms;
        $scope.repoId = "";
        $scope.source = {
          type: "GitHubDownload",
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
        }
        $scope.$apply();
      };

      async function getDetails() {
        const o = parseGithubUrl($scope.repoUrl);
        try {
          resetValidity();
          const res = await $http.get(`/api/repo/${o.owner}/${o.repo}/`);
          $scope.details = res.data;
          if ($scope.details.size > $scope.site_options.MAX_REPO_SIZE) {
            $scope.options.mode = "GitHubStream";
            $scope.anonymize.mode.$$element[0].disabled = true;
          }
          $scope.repoId = $scope.details.repo + "-" + generateRandomId(4);
          await $scope.getBranches();
        } catch (error) {
          if (error.data) {
            $translate("ERRORS." + error.data.error).then((translation) => {
              $scope.error = translation;
            }, console.error);
            displayErrorMessage(error.data.error);
          }
          $scope.anonymize.repoUrl.$setValidity("missing", false);
          throw error;
        }
      }

      async function getReadme(force) {
        if ($scope.readme) return $scope.readme;
        const o = parseGithubUrl($scope.repoUrl);
        const res = await $http.get(`/api/repo/${o.owner}/${o.repo}/readme`, {
          params: {
            force: force === true ? "1" : "0",
            branch: $scope.source.branch,
          },
        });
        $scope.readme = res.data;
      }

      function anonymize() {
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

        $scope.anonymize_readme = content;
        const html = marked($scope.anonymize_readme);
        $scope.html_readme = $sce.trustAsHtml(html);
        setTimeout(Prism.highlightAll, 150);
      }

      function resetValidity() {
        $scope.anonymize.repoId.$setValidity("used", true);
        $scope.anonymize.repoId.$setValidity("format", true);
        $scope.anonymize.repoUrl.$setValidity("used", true);
        $scope.anonymize.repoUrl.$setValidity("missing", true);
        $scope.anonymize.repoUrl.$setValidity("access", true);
        $scope.anonymize.terms.$setValidity("format", true);
        $scope.anonymize.terms.$setValidity("format", true);
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

      $scope.$watch("source.branch", async (v) => {
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

      $scope.$watch("source.type", (v) => {
        if (v == "GitHubStream") {
          $scope.options.page = false;
          $scope.anonymize.page.$$element[0].disabled = true;
        } else {
          $scope.anonymize.page.$$element[0].disabled = false;
        }
      });

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
    "PDFViewerService",
    function ($scope, $http, $location, $routeParams, PDFViewerService) {
      const extensionModes = {
        yml: "yaml",
        txt: "text",
        py: "python",
        js: "javascript",
        ts: "typescript",
      };
      const textFiles = ["license", "txt"];
      const imageFiles = ["png", "jpg", "jpeg", "gif"];

      $scope.$on("$routeUpdate", function (event, current, old) {
        $scope.filePath = $routeParams.path || "";
        $scope.paths = $scope.filePath.split("/");

        if ($scope.repoId != $routeParams.repoId) {
          return init();
        }

        updateContent();
      });

      function getFiles(callback) {
        $http.get(`/api/repo/${$scope.repoId}/files/`).then(
          (res) => {
            $scope.files = res.data;
            if ($scope.paths.length == 0 || $scope.paths[0] == "") {
              for (let file in $scope.files) {
                // redirect to readme
                if (file.toLowerCase().indexOf("readme") > -1) {
                  let uri = $location.url();
                  if (uri[uri.length - 1] != "/") {
                    uri += "/";
                  }

                  // redirect to readme
                  $location.url(uri + file);
                }
              }
            }
            if (callback) {
              return callback();
            }
          },
          (err) => {
            console.log(err);
            $scope.files = [];
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
        if (extension == "ipynb") {
          return "IPython";
        }
        if (textFiles.indexOf(extension) > -1) {
          return "text";
        }
        if (imageFiles.indexOf(extension) > -1) {
          return "image";
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
                const md = contentAbs2Relative(res.data);
                $scope.content = marked(md, { baseUrl: $location.url() });
                $scope.type = "html";
              }
              setTimeout(() => {
                Prism.highlightAll();
              }, 50);
            },
            (err) => {
              $scope.type = "error";
              try {
                err.data = JSON.parse(err.data);
              } catch (ignore) {}
              if (err.data.error) {
                $scope.content = err.data.error;
              } else {
                $scope.content = err.data;
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
        status: { ready: true, expired: true, removed: true },
      };
      $scope.orderBy = "name";

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
    function ($scope, $http, $location) {
      $scope.$watch("user.status", () => {
        if ($scope.user == null) {
          $location.url("/");
        }
      });
      if ($scope.user == null) {
        $location.url("/");
      }

      const end = new Date()
      end.setMonth(new Date().getMonth() + 6)
      $scope.options = {
        startDate: new Date(),
        endDate: end,
        mode: 'free',
        nbRepository: 30
      }
    },
  ])
  .controller("conferenceController", [
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
    },
  ]);
