angular
  .module("admin", [])
  .controller("repositoriesAdminController", [
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

      $scope.repositories = [];
      $scope.total = -1;
      $scope.totalPage = 0;
      $scope.query = {
        page: 1,
        limit: 25,
        sort: "lastView",
        search: "",
        ready: false,
        expired: false,
        removed: false,
        error: true,
        preparing: true,
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
        repo.s;

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

      function getRepositories() {
        $http.get("/api/admin/repos", { params: $scope.query }).then(
          (res) => {
            $scope.total = res.data.total;
            $scope.totalPage = Math.ceil(res.data.total / $scope.query.limit);
            $scope.repositories = res.data.results;
          },
          (err) => {
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
        },
        true
      );
    },
  ])
  .controller("usersAdminController", [
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

      $scope.users = [];
      $scope.total = -1;
      $scope.totalPage = 0;
      $scope.query = {
        page: 1,
        limit: 25,
        sort: "username",
        search: "",
      };

      function getUsers() {
        $http.get("/api/admin/users", { params: $scope.query }).then(
          (res) => {
            $scope.total = res.data.total;
            $scope.totalPage = Math.ceil(res.data.total / $scope.query.limit);
            $scope.users = res.data.results;
            $scope.$apply();
          },
          (err) => {
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
        },
        true
      );
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
        repo.s;

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
      $scope.query = {
        page: 1,
        limit: 25,
        sort: "name",
        search: "",
      };

      function getConferences() {
        $http.get("/api/admin/conferences", { params: $scope.query }).then(
          (res) => {
            $scope.total = res.data.total;
            $scope.totalPage = Math.ceil(res.data.total / $scope.query.limit);
            $scope.conferences = res.data.results;
            $scope.$apply();
          },
          (err) => {
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
        },
        true
      );
    },
  ])
  .controller("queuesAdminController", [
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

      $scope.downloadJobs = [];
      $scope.removeJobs = [];

      function getQueues() {
        $http.get("/api/admin/queues", { params: $scope.query }).then(
          (res) => {
            $scope.downloadJobs = res.data.downloadQueue;
            $scope.removeJobs = res.data.removeQueue;
            $scope.removeCaches = res.data.cacheQueue;
          },
          (err) => {
            console.error(err);
          }
        );
      }
      getQueues();

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
    },
  ]);
