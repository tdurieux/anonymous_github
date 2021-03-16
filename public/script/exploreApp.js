angular
  .module("anonymous-github", [
    "ngRoute",
    "ngSanitize",
    "ui.ace",
    "ngPDFViewer",
  ])
  .config(function($routeProvider, $locationProvider) {
    $routeProvider
      .when("/:path*", {
        templateUrl: "/partials/explore.htm",
        controller: "exploreController",
        title: "Explore",
      })
      .otherwise({
        templateUrl: "/partials/loading.htm",
        title: "Anonymous Github",
      });
    $locationProvider.html5Mode(true);
  })
  .factory("RecursionHelper", [
    "$compile",
    function($compile) {
      return {
        /**
         * Manually compiles the element, fixing the recursion loop.
         * @param element
         * @param [link] A post-link function, or an object with function(s) registered via pre and post properties.
         * @returns An object containing the linking functions.
         */
        compile: function(element, link) {
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
            post: function(scope, element) {
              // Compile the contents
              if (!compiledContents) {
                compiledContents = $compile(contents);
              }
              // Re-add the compiled contents to the element
              compiledContents(scope, function(clone) {
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
    function(RecursionHelper) {
      return {
        restrict: "E",
        scope: { file: "=", parent: "@" },
        // template:
        //   "<ul>" +
        //   '<li class="file" ng-repeat="f in afiles" ng-class="{folder: isDir(f.child), active: isActive(f.name), open: opens[f.name]}">' +
        //   "<a href='/r/{{repoId}}/{{parent}}/{{f.name}}' ng-if='!isDir(f.child)'>{{f.name}}</a>" +
        //   "<a ng-click='openFolder(f.name)' ng-if='isDir(f.child)'>{{f.name}}</a>" +
        //   '<tree file="f.child" parent="{{parent}}/{{f.name}}" ng-if="isDir(f.child)""></tree>' +
        //   "</li>" +
        //   "</ul>",
        compile: function(element) {
          return RecursionHelper.compile(element);
        },
        controller: function($element, $scope, $location, $compile) {
          $scope.repoId = document.location.pathname.split("/")[2];

          $scope.opens = {};
          const toArray = function(obj) {
            const output = [];
            for (let name in obj) {
              if (obj[name].size != null) {
                // it is a file
                output.push({ name, size: obj[name].size, sha: obj[name].sha });
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
                output += `<a href='/r/${$scope.repoId}/${path}'>${name}</a>`;
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

          $scope.isActive = function(name) {
            return $location.path() == name;
          };

          $scope.openFolder = function(folder, event) {
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
          const isFile = function(child) {
            return child == null || child.size != null;
          };
          const isDir = function(child) {
            return !isFile(child);
          };
        },
      };
    },
  ])
  .directive("notebook", [
    function() {
      return {
        restrict: "E",
        scope: { file: "=" },
        controller: function($element, $scope, $http) {
          function render() {
            if (!$scope.file) return;
            $http.get($scope.file).then((res) => {
              var notebook = nb.parse(res.data);
              var rendered = notebook.render();
              // console.log(angular.element(rendered))
              $element.append(rendered);
              Prism.highlightAll();
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
    $scope.error = null;
    $scope.files = null;
    $scope.repoId = document.location.pathname.split("/")[2];
    $scope.paths = $location
      .path()
      .substring(1)
      .split("/");

    $scope.$on("$routeChangeSuccess", function(event, current) {
      $scope.paths = $location
        .path()
        .substring(1)
        .split("/");
    });

    function getFiles(callback) {
      $http.get(`/api/repo/${$scope.repoId}/files/`).then(
        (res) => {
          $scope.files = res.data;
          if ($scope.paths.length == 0 || $scope.paths[0] == "") {
            for (let file in $scope.files) {
              if (file.toLowerCase().indexOf("readme") > -1) {
                $location.url(file);
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

    function getStats() {
      $http.get(`/api/repo/${$scope.repoId}/stats/`).then(
        (res) => {
          $scope.stats = res.data;
        },
        (err) => {
          console.log(err);
        }
      );
    }
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
          if (err.data.error == "repository_expired") {
            $scope.error = "The repository is not available!";
          } else if (err.data.error == "repo_not_found") {
            $scope.error = "The repository is not found!";
          } else {
            console.log(err);
          }
        }
      );
    }
    getOptions((options) => {
      getFiles(() => {
        if (options.mode == "download") {
          getStats();
        }
      });
    });
  })
  .controller("exploreController", function(
    $scope,
    $http,
    $routeParams,
    PDFViewerService
  ) {
    const extensionModes = {
      yml: "yaml",
      txt: "text",
      py: "python",
      js: "javascript",
    };
    const textFiles = ["license", "txt"];
    const imageFiles = ["png", "jpg", "jpeg", "gif"];

    $scope.content = "";
    $scope.path = $routeParams.path;
    $scope.url = `/api/repo/${$scope.repoId}/file/${$scope.path}`;

    let extension = $routeParams.path.toLowerCase();
    const extensionIndex = extension.lastIndexOf(".");
    if (extensionIndex > -1) {
      extension = extension.substring(extensionIndex + 1);
    }

    $scope.type = getType(extension);

    function getMode(extension) {
      if (extensionModes[extension]) {
        return extensionModes[extension];
      }
      return extension;
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
      highlightActiveLine: true,
      showInvisibles: false,
      showIndentGuides: true,
      showPrintMargin: false,
      highlightSelectedWord: true,
      enableBehaviours: true,
      fadeFoldWidgets: false,
      mode: getMode(extension),

      onLoad: function(_editor) {
        _editor.setFontSize($scope.aceOption.fontSize);
        _editor.setReadOnly($scope.aceOption.readOnly);
        _editor.setKeyboardHandler($scope.aceOption.keyBinding);
        _editor.setSelectionStyle(
          $scope.aceOption.fullLineSelection ? "line" : "text"
        );
        _editor.setOption("displayIndentGuides", true);
        _editor.setHighlightActiveLine($scope.aceOption.highlightActiveLine);
        _editor.setShowInvisibles($scope.aceOption.showInvisibles);
        _editor.setDisplayIndentGuides($scope.aceOption.showIndentGuides);

        _editor.renderer.setShowPrintMargin($scope.aceOption.showPrintMargin);
        _editor.setHighlightSelectedWord(
          $scope.aceOption.highlightSelectedWord
        );
        _editor.session.setUseSoftTabs($scope.aceOption.useSoftTab);
        _editor.session.setTabSize($scope.aceOption.tabSize);
        _editor.setBehavioursEnabled($scope.aceOption.enableBehaviours);
        _editor.setFadeFoldWidgets($scope.aceOption.fadeFoldWidgets);
      },
    };

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
      $http
        .get(`/api/repo/${$scope.repoId}/file/${path}`, {
          transformResponse: (data) => {
            return data;
          },
        })
        .then(
          (res) => {
            $scope.content = res.data;
            if ($scope.content == "") {
              $scope.content = null;
            }

            if ($scope.type == "md") {
              $scope.content = marked(res.data);
              $scope.type = "html";
            }
            setTimeout(() => {
              Prism.highlightAll();
            }, 50);
          },
          (err) => {
            $scope.type = "error";
            console.log(err);
            $scope.content = err.data;
          }
        );
    }
    getContent($routeParams.path ? $routeParams.path : "");
  });
