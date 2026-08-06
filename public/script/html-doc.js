/**
 * Renders a repository's .html file as a document instead of showing its
 * source (#771). Self-contained HTML reports — Quarto, R Markdown, nbconvert
 * — are a common way to ship rendered results, and dumping several megabytes
 * of markup into the code editor was neither readable nor fast.
 *
 * The markup is untrusted: it comes from the repository under review. It is
 * therefore written into a `sandbox`ed iframe, and scripts are OFF by default
 * — the reader opts in per file with the "Enable JS" action. Even when they
 * do, the sandbox never gets `allow-same-origin`: with `allow-scripts` that
 * pair lets the framed document remove its own sandbox, after which it could
 * reach the app's cookies, session and DOM.
 *
 * We use `srcdoc` rather than pointing the iframe at the file API so the
 * response's `X-Frame-Options: SAMEORIGIN` doesn't block the frame: under
 * sandbox the document's origin is opaque and never matches "same origin".
 * An injected <base> keeps any relative images/stylesheets resolving against
 * the file's own directory in the anonymized repo.
 */

angular.module("htmlDoc", []).directive("htmlDoc", [
  function () {
    return {
      restrict: "E",
      scope: {
        content: "<",
        baseUrl: "@",
        allowScripts: "<",
      },
      link: function (scope, element) {
        const host = element[0];
        host.classList.add("html-doc");

        function render() {
          // The sandbox attribute only takes effect on navigation, so a fresh
          // iframe is the reliable way to apply a changed policy.
          host.innerHTML = "";
          const content = scope.content;
          if (typeof content !== "string") return;

          const iframe = document.createElement("iframe");
          iframe.className = "html-doc-frame";
          iframe.setAttribute("title", "Rendered HTML document");
          // No allow-same-origin — see the note above.
          const sandbox = ["allow-popups", "allow-popups-to-escape-sandbox"];
          if (scope.allowScripts) {
            sandbox.push("allow-scripts", "allow-forms", "allow-modals");
          }
          iframe.setAttribute("sandbox", sandbox.join(" "));
          iframe.setAttribute("referrerpolicy", "no-referrer");
          host.appendChild(iframe);

          let base = "";
          if (scope.baseUrl) {
            base =
              '<base href="' +
              scope.baseUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;") +
              '">';
          }
          iframe.srcdoc = base + content;
        }

        scope.$watch("content", render);
        scope.$watch("baseUrl", render);
        scope.$watch("allowScripts", render);
      },
    };
  },
]);
