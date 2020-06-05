angular
  .module("anonymous-github", ["ngRoute"])
  .config(function ($routeProvider, $locationProvider) {
    $routeProvider
      .when("/myrepo", {
        templateUrl: "/partials/repos.htm",
        controller: "reposController",
        title: "Repo",
      })
      .when("/", {
        templateUrl: "/partials/home.htm",
        controller: "homeController",
        title: "Home",
      })
      .when("/404", {
        templateUrl: "/partials/404.htm",
        title: "Not Found!",
      });
    //.otherwise("/error");
    $locationProvider.html5Mode(true);
  })
  .filter("filterObj", function () {
    return function (input, search) {
      if (!input) return input;
      if (!search) return input;
      var result = {};
      angular.forEach(input, function (value, key) {
        if (search(value)) {
          result[key] = value;
        }
      });
      return result;
    };
  })
  .controller("reposController", function ($scope, $http) {
    $scope.repos = [];
    $http.get("/api/repos").then((res) => {
      $scope.repos = res.data.data;
    });
  })
  .controller("mainController", function ($scope, $http) {
    $scope.title = "Main";
    $scope.user = null;

    $http.get("/api/user").then(
      (res) => {
        if (res) $scope.user = res.data;
      },
      () => {
        $scope.user = null;
      }
    );

    $scope.$on("$routeChangeSuccess", function (event, current) {
      if (current) {
        $scope.title = current.title;
      }
    });
  })
  .controller("homeController", function ($scope) {
    console.log("here");
  });
