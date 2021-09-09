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
        sort: "source.repositoryName",
        search: "",
        ready: true,
        expired: true,
        removed: true,
        error: true,
        preparing: true,
      };

      function getRepositories() {
        $http.get("/api/admin/repos", { params: $scope.query }).then(
          (res) => {
            $scope.total = res.data.total;
            $scope.totalPage = Math.ceil(res.data.total / $scope.query.limit);
            $scope.repositories = res.data.results;
            $scope.$apply();
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
        search: ""
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
  ]);
