angular
  .module("anonymous-github", ["ngRoute"])
  .config(function($routeProvider, $locationProvider) {
    $routeProvider
      .when("/", {
        templateUrl: "/partials/home.htm",
        controller: "homeController",
        title: "Anonymous GitHub",
      })
      .when("/dashboard", {
        templateUrl: "/partials/dashboard.htm",
        controller: "dashboardController",
        title: "Anonymous GitHub",
      })
      .when("/anonymize/:repoId?", {
        templateUrl: "/partials/anonymize.htm",
        controller: "anonymizeController",
        title: "Anonymous GitHub",
      })
      .when("/404", {
        templateUrl: "/partials/404.htm",
        title: "Not Found!",
      })
      .when("/faq", {
        templateUrl: "/partials/faq.htm",
        controller: "faqController",
        title: "Not Found!",
      })
      .when("/claim", {
        templateUrl: "/partials/claim.htm",
        controller: "claimController",
        title: "Not Found!",
      })
      .otherwise({
        templateUrl: "/partials/404.htm",
        title: "Not Found!",
      });
    $locationProvider.html5Mode(true);
  })
  .filter("filterObj", function() {
    return function(input, search) {
      if (!input) return input;
      if (!search) return input;
      var result = {};
      angular.forEach(input, function(value, key) {
        if (search(value)) {
          result[key] = value;
        }
      });
      return result;
    };
  })
  .controller("mainController", function($scope, $http, $location) {
    $scope.title = "Main";
    $scope.user = { status: "connection" };

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

    $scope.$on("$routeChangeSuccess", function(event, current) {
      if (current) {
        $scope.title = current.title;
      }
      $scope.path = $location.url();
    });

    $scope.path = $location.url();
  })
  .controller("faqController", function($scope, $http) {
    function getSupportedFileTypes() {
      $http.get("/api/supportedTypes").then((res) => {
        $scope.supportedFileTypes = res.data;
      });
    }
    getSupportedFileTypes();
  })
  .controller("claimController", function($scope, $location, $http) {
    $scope.repoId = null;
    $scope.repoUrl = null;
    $scope.claim = () => {
      console.log("here");
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
  })
  .controller("homeController", function($scope, $location, $http) {
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
  })
  .controller("dashboardController", function($scope, $http, $location) {
    $scope.$watch("user.status", () => {
      if ($scope.user == null) {
        $location.url("/");
      }
    });
    if ($scope.user == null) {
      $location.url("/");
    }

    $('[data-toggle="tooltip"]').tooltip();

    $scope.repositories = [];
    $scope.search = "";
    $scope.filters = {
      status: { ready: true, expired: false, removed: false },
    };
    $scope.orderBy = "-anonymizeDate";

    function getRepositories() {
      $http.get("/api/user/anonymized_repositories").then(
        (res) => {
          $scope.repositories = res.data;
        },
        (err) => {
          console.error(err);
        }
      );
    }
    getRepositories();

    $scope.removeRepository = (repo) => {
      if (
        confirm(
          `Are you sure that you want to remove the repository ${repo.repoId}?`
        )
      ) {
        $http.delete(`/api/repo/${repo.repoId}`).then(() => {
          getRepositories();
        });
      }
    };

    $scope.updateRepository = (repo) => {
      $http.post(`/api/repo/${repo.repoId}/refresh`).then(() => {
        alert(`${repo.repoId} is refreshed.`);
        getRepositories();
      });
    };

    $scope.repoFiler = (repo) => {
      if ($scope.filters.status[repo.status] == false) return false;

      if ($scope.search.trim().length == 0) return true;

      if (repo.fullName.indexOf($scope.search) > -1) return true;
      if (repo.repoId.indexOf($scope.search) > -1) return true;

      return false;
    };
  })
  .controller("anonymizeController", function(
    $scope,
    $http,
    $sce,
    $routeParams,
    $location
  ) {
    $scope.repoUrl = "";
    $scope.repoId = "";
    $scope.terms = "";
    $scope.branch = "";

    $scope.branches = [];

    $scope.options = {
      expirationMode: "remove",
      expirationDate: new Date(),
      update: false,
      image: true,
      pdf: true,
      notebook: true,
      loc: true,
      link: true,
      mode: "download",
    };
    $scope.options.expirationDate.setDate(90);
    $scope.anonymize_readme = "";
    $scope.readme = "";
    $scope.html_readme = "";
    $scope.isUpdate = false;

    if ($routeParams.repoId && $routeParams.repoId != "") {
      $scope.isUpdate = true;
      $scope.repoId = $routeParams.repoId;
      $http.get("/api/repo/" + $scope.repoId).then(
        async (res) => {
          $scope.repoUrl = "https://github.com/" + res.data.fullName;

          $scope.terms = res.data.terms.join("\n");
          $scope.options = res.data.options;
          $scope.options.expirationDate = new Date(res.data.options.expirationDate);

          $scope.details = (await $http.get(
            `/api/repo/${res.data.fullName}/`
          )).data;

          await getReadme();
          await $scope.getBranches();
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

    $scope.repositories = [];

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
      $scope.terms = "";
      $scope.repoId = "";
      $scope.branch = "";

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

    $scope.$watch("branch", (v) => {
      if ($scope.branches && $scope.branches[$scope.branch]) {
        $scope.commit = $scope.branches[$scope.branch].commit.sha;
      }
      if ($scope.details.has_page) {
        $scope.anonymize.page.disabled(false);
        if ($scope.details.pageSource.branch != $scope.branch) {
          $scope.anonymize.page.disabled(true);
        }
      }
    });

    $scope.$watch("options.mode", (v) => {
      if (v == "stream") {
        $scope.options.loc = false;
        $scope.anonymize.loc.$$element[0].disabled = true;
      }
    });

    function parseGithubUrl(url) {
      var matches = url.match(/.*?github.com\/([\w-\._]+)\/([\w-\._]+)/);
      if (matches && matches.length == 3) {
        return {
          owner: matches[1],
          repo: matches[2],
        };
      } else {
        throw "Invalid url";
      }
    }
    $scope.getBranches = async (force) => {
      const o = parseGithubUrl($scope.repoUrl);
      const branches = await $http.get(
        `/api/repo/${o.owner}/${o.repo}/branches`,
        { params: { force: force === true ? "1" : "0" } }
      );
      $scope.branches = branches.data;
      $scope.branch = $scope.details.default_branch;
      if ($scope.branches[$scope.branch]) {
        $scope.commit = $scope.branches[$scope.branch].commit.sha;
      }
      $scope.$apply();
    };
    function generateRandomId(length) {
      const alphabet = "ABCDEF0123456789";
      let output = "";
      for (let index = 0; index < length; index++) {
        output += alphabet[Math.round(Math.random() * (alphabet.length - 1))];
      }
      return output;
    }
    async function getDetails() {
      const o = parseGithubUrl($scope.repoUrl);
      console.log(o, $scope.repoUrl)
      try {
        $scope.anonymize.repoUrl.$setValidity("missing", true);
        const res = await $http.get(`/api/repo/${o.owner}/${o.repo}/`);
        $scope.details = res.data;
        if ($scope.details.size > 1024 * 8) {
          $scope.options.mode = "stream";
          $scope.options.loc = false;
          $scope.anonymize.mode.$$element[0].disabled = true;
          $scope.anonymize.loc.$$element[0].disabled = true;
        }
        $scope.repoId = $scope.details.name + "-" + generateRandomId(4);
        await $scope.getBranches();
      } catch (error) {
        console.error(error);
        $scope.anonymize.repoUrl.$setValidity("missing", false);
        throw error;
      }
    }

    async function getReadme() {
      const o = parseGithubUrl($scope.repoUrl);
      const res = await $http.get(`/api/repo/${o.owner}/${o.repo}/readme`);
      $scope.readme = res.data;
    }

    async function anonymize() {
      const urlRegex = /<?\b((https?|ftp|file):\/\/)[-A-Za-z0-9+&@#/%?=~_|!:,.;]+[-A-Za-z0-9+&@#/%=~_|]\b\/?>?/g;
      let content = $scope.readme;

      if (!$scope.options.image) {
        // remove images
        content = content.replace(
          /!\[[^\]]*\]\((?<filename>.*?)(?=\"|\))(?<optionalpart>\".*\")?\)/g,
          ""
        );
      }
      if (!$scope.options.link) {
        content = content.replace(urlRegex, "XXX");
      }

      content = content.replace(
        new RegExp(`\\b${$scope.repoUrl}/blob/${$scope.branch}\\b`, "gi"),
        `https://anonymous.4open.science/r/${$scope.repoId}`
      );
      content = content.replace(
        new RegExp(`\\b${$scope.repoUrl}/tree/${$scope.branch}\\b`, "gi"),
        `https://anonymous.4open.science/r/${$scope.repoId}`
      );
      content = content.replace(
        new RegExp(`\\b${$scope.repoUrl}`, "gi"),
        `https://anonymous.4open.science/r/${$scope.repoId}`
      );

      for (let term of $scope.terms.split("\n")) {
        if (term.trim() == "") {
          continue;
        }
        // remove whole url if it contains the term

        content = content.replace(urlRegex, (match) => {
          if (new RegExp(`\\b${term}\\b`, "gi").test(match)) return "XXX";
          return match;
        });

        // remove the term in the text
        content = content.replace(new RegExp(`\\b${term}\\b`, "gi"), "XXX");
      }

      $scope.anonymize_readme = content;
      $scope.html_readme = $sce.trustAsHtml(marked($scope.anonymize_readme));
      setTimeout(Prism.highlightAll, 150);
    }

    function resetValidity() {
      $scope.anonymize.repoId.$setValidity("used", true);
      $scope.anonymize.repoId.$setValidity("format", true);
      $scope.anonymize.repoUrl.$setValidity("used", true);
      $scope.anonymize.terms.$setValidity("format", true);
    }

    function getRepo() {
      const o = parseGithubUrl($scope.repoUrl);
      return {
        repoId: $scope.repoId,
        terms: $scope.terms.trim().split("\n"),
        fullName: `${o.owner}/${o.repo}`,
        repository: $scope.repoUrl,
        options: $scope.options,
        branch: $scope.branch,
        commit: $scope.commit,
      };
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
        default:
          $scope.anonymize.$setValidity("error", false);
          break;
      }
    }
    $scope.anonymizeRepo = async (event) => {
      event.target.disabled = true;
      resetValidity();

      const newRepo = getRepo();
      try {
        await $http.post("/api/repo/", newRepo, {
          headers: { "Content-Type": "application/json" },
        });
        window.location.href = "/r/" + $scope.repoId;
      } catch (error) {
        if (error.data) {
          displayErrorMessage(error.data.error);
        } else {
          console.error(error);
        }
      } finally {
        event.target.disabled = false;
      }
      $scope.$apply();
    };

    $scope.updateRepo = async (event) => {
      event.target.disabled = true;
      resetValidity();

      const newRepo = getRepo();
      try {
        await $http.post("/api/repo/" + newRepo.repoId, newRepo, {
          headers: { "Content-Type": "application/json" },
        });
        window.location.href = "/r/" + $scope.repoId;
      } catch (error) {
        if (error.data) {
          displayErrorMessage(error.data.error);
        } else {
          console.error(error);
        }
      } finally {
        event.target.disabled = false;
      }
      $scope.$apply();
    };

    $scope.$watch("terms", anonymize);
    $scope.$watch("options.image", anonymize);
    $scope.$watch("options.link", anonymize);
  });
