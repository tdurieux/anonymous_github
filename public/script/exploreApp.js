angular
  .module("anonymous-github", ["ngRoute", "ngSanitize"])
  .config(function ($routeProvider, $locationProvider) {
    $routeProvider
      .when("/:path*", {
        templateUrl: "/partials/explore.htm",
        controller: "exploreController",
        title: "Explore",
      })
      .when("/404", {
        templateUrl: "/partials/404.htm",
        title: "Not Found!",
      });
    //.otherwise("/error");
    $locationProvider.html5Mode(true);
  })
  .factory("RecursionHelper", [
    "$compile",
    function ($compile) {
      return {
        /**
         * Manually compiles the element, fixing the recursion loop.
         * @param element
         * @param [link] A post-link function, or an object with function(s) registered via pre and post properties.
         * @returns An object containing the linking functions.
         */
        compile: function (element, link) {
          // Normalize the link parameter
          if (angular.isFunction(link)) {
            link = { post: link };
          }

          // Break the recursion loop by removing the contents
          var contents = element.contents().remove();
          var compiledContents;
          return {
            pre: link && link.pre ? link.pre : null,
            /**
             * Compiles and re-adds the contents
             */
            post: function (scope, element) {
              // Compile the contents
              if (!compiledContents) {
                compiledContents = $compile(contents);
              }
              // Re-add the compiled contents to the element
              compiledContents(scope, function (clone) {
                element.append(clone);
              });

              // Call the post-linking function, if any
              if (link && link.post) {
                link.post.apply(null, arguments);
              }
            },
          };
        },
      };
    },
  ])
  .directive("tree", [
    "RecursionHelper",
    function (RecursionHelper) {
      return {
        restrict: "E",
        scope: { file: "=", parent: "@" },
        template:
          "<ul>" +
          '<li class="file" ng-repeat="(name, child) in file" ng-class="{folder: isDir(child), active: isActive(name), open: opens[name]}">' +
          "<a href='/r/{{repoId}}/{{parent}}/{{name}}' ng-if='!isDir(child)'>{{name}}</a>" +
          "<a ng-click='openFolder(name)' ng-if='isDir(child)'>{{name}}</a>" +
          '<tree file="child" parent="{{parent}}/{{name}}" ng-if="isDir(child)""></tree>' +
          "</li>" +
          "</ul>",
        compile: function (element) {
          // Use the compile function from the RecursionHelper,
          // And return the linking function(s) which it returns
          return RecursionHelper.compile(element);
        },
        controller: function ($scope, $location) {
          $scope.repoId = document.location.pathname.split("/")[2];
          $scope.opens = {};
          $scope.isActive = function (name) {
            return $location.path() == $scope.parent + "/" + name;
          };
          $scope.openFolder = function (folder) {
            $scope.opens[folder] = !$scope.opens[folder];
          };
          $scope.isDir = function (child) {
            return !Number.isInteger(child);
          };
        },
      };
    },
  ])
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
  .controller("mainController", function ($scope, $http, $location) {
    $scope.files = [];
    $scope.repoId = document.location.pathname.split("/")[2];
    $scope.paths = $location.path().split("/");

    $scope.$on("$routeChangeSuccess", function (event, current) {
      console.log(event, current);
      $scope.paths = $location.path().split("/");
    });

    function getFiles() {
      $http.get(`/api/files/${$scope.repoId}`).then(
        (res) => {
          $scope.files = res.data;
        },
        (err) => {
          console.log(err);
          $scope.files = [];
        }
      );
    }
    getFiles();

    $http.get(`/api/stat/${$scope.repoId}`).then(
      (res) => {
        console.log(res.data);
      },
      (err) => {
        console.log(err);
      }
    );
  })
  .controller("exploreController", function ($scope, $http, $routeParams) {
    console.log("here");
    $scope.content = "";
    $scope.type = "code";

    const textFiles = ["LICENSE", ".txt"];

    function getContent(path) {
      $http.get(`/api/repository/${$scope.repoId}/${path}`).then(
        (res) => {
          $scope.content = res.data;
          if ($scope.content == "") {
            $scope.content = null;
          }
          $scope.type = "code";

          for (let t of textFiles) {
            if (path.toLowerCase().indexOf(t.toLowerCase()) > -1) {
              $scope.type = "text";
              break;
            }
          }
          if ($scope.type == "code" && path.toLowerCase().indexOf(".md") > -1) {
            $scope.content = marked(res.data);
            $scope.type = "html";
          }
          setTimeout(() => {
            document.querySelectorAll("pre code").forEach((block) => {
              hljs.highlightBlock(block);
              hljs.lineNumbersBlock(block);
            });
          }, 50);
        },
        (err) => {
          console.log(err);
          $scope.content = err.data;
          // $location.url("/" + err.status);
        }
      );
    }
    getContent($routeParams.path ? $routeParams.path : "");
  });
