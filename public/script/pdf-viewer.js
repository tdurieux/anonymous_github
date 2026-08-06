/**
 * AngularJS PDF viewer directive built on pdf.js.
 *
 * Replaces the old ng-pdfviewer directive, which drove pdf.js 0.8.505 (2013)
 * through the long-removed `PDFJS.getDocument()` global API. That build
 * emitted malformed CFF/OpenType data for subsetted fonts — the browser
 * rejected the font ("OTS parsing error: CFF: Failed to parse Top DICT
 * Data") and every glyph fell back to the wrong character, so PDFs rendered
 * as garbage text rather than failing outright (#771).
 *
 * Pages rasterise lazily as they scroll into view: a LaTeX/Quarto report can
 * run to dozens of pages, and drawing every canvas up front costs hundreds of
 * megabytes. Visibility is computed from element rects rather than an
 * IntersectionObserver — an observer reports nothing while the tab is
 * occluded, which would leave the reader looking at empty placeholders.
 */

angular.module("ngPDFViewer", []).directive("pdfviewer", [
  "$window",
  function ($window) {
    // How far beyond the viewport to rasterise, so scrolling stays ahead of
    // the reader.
    const PRERENDER_MARGIN = 400;
    const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
    // Widest a page is drawn at 100%; beyond this a page is more comfortable
    // to read zoomed than stretched across a wide monitor.
    const FIT_MAX_WIDTH = 1000;

    return {
      restrict: "E",
      scope: {
        src: "@",
      },
      link: function (scope, element) {
        const container = element[0];
        container.classList.add("pdf-viewer");

        let doc = null;
        let slots = [];
        let scheduled = false;
        let resizeTimer = null;
        let zoom = 1;
        let currentPage = 1;
        // Page the reader asked for, held against layout shifts until
        // anchorUntil passes.
        let anchorPage = 0;
        let anchorUntil = 0;
        let aspect = 612 / 792; // US Letter, replaced once page 1 is known
        // Bumped on every load so pages still resolving from a previous
        // document are dropped instead of appended to the new one.
        let generation = 0;

        // ---------------------------------------------------------------
        // Toolbar
        // ---------------------------------------------------------------
        const toolbar = document.createElement("div");
        toolbar.className = "pdf-toolbar";
        const pages = document.createElement("div");
        pages.className = "pdf-pages";
        // Focusable so the arrow/Page keys scroll the document.
        pages.tabIndex = 0;
        pages.setAttribute("aria-label", "PDF pages");
        container.appendChild(toolbar);
        container.appendChild(pages);

        function button(icon, label, onClick) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "pdf-toolbar-btn";
          b.title = label;
          b.setAttribute("aria-label", label);
          b.innerHTML = '<i class="fas ' + icon + '"></i>';
          b.addEventListener("click", onClick);
          return b;
        }

        const prevBtn = button("fa-chevron-up", "Previous page", function () {
          goToPage(currentPage - 1);
        });
        const nextBtn = button("fa-chevron-down", "Next page", function () {
          goToPage(currentPage + 1);
        });

        const pageInput = document.createElement("input");
        pageInput.type = "text";
        pageInput.className = "pdf-toolbar-page";
        pageInput.setAttribute("aria-label", "Page number");
        pageInput.title = "Page number — type a page and press Enter";
        pageInput.addEventListener("keydown", function (e) {
          if (e.key === "Enter") {
            goToPage(parseInt(pageInput.value, 10));
            pageInput.blur();
          }
        });
        pageInput.addEventListener("blur", function () {
          pageInput.value = String(currentPage);
        });

        const pageCount = document.createElement("span");
        pageCount.className = "pdf-toolbar-count";

        const zoomOutBtn = button("fa-search-minus", "Zoom out", function () {
          setZoom(ZOOM_STEPS[Math.max(0, zoomIndex() - 1)]);
        });
        const zoomInBtn = button("fa-search-plus", "Zoom in", function () {
          setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, zoomIndex() + 1)]);
        });
        const zoomLabel = document.createElement("button");
        zoomLabel.type = "button";
        zoomLabel.className = "pdf-toolbar-btn pdf-toolbar-zoom";
        zoomLabel.title = "Reset zoom to fit the width";
        zoomLabel.setAttribute("aria-label", "Reset zoom to fit the width");
        zoomLabel.addEventListener("click", function () {
          setZoom(1);
        });

        toolbar.appendChild(prevBtn);
        toolbar.appendChild(nextBtn);
        const pageGroup = document.createElement("span");
        pageGroup.className = "pdf-toolbar-group";
        pageGroup.appendChild(pageInput);
        pageGroup.appendChild(pageCount);
        toolbar.appendChild(pageGroup);
        const zoomGroup = document.createElement("span");
        zoomGroup.className = "pdf-toolbar-group pdf-toolbar-right";
        zoomGroup.appendChild(zoomOutBtn);
        zoomGroup.appendChild(zoomLabel);
        zoomGroup.appendChild(zoomInBtn);
        toolbar.appendChild(zoomGroup);

        function zoomIndex() {
          let best = 0;
          for (let i = 0; i < ZOOM_STEPS.length; i++) {
            if (Math.abs(ZOOM_STEPS[i] - zoom) < Math.abs(ZOOM_STEPS[best] - zoom)) {
              best = i;
            }
          }
          return best;
        }

        function syncToolbar() {
          const total = doc ? doc.numPages : 0;
          toolbar.style.display = total ? "" : "none";
          pageCount.textContent = "/ " + total;
          if (document.activeElement !== pageInput) {
            pageInput.value = String(currentPage);
          }
          prevBtn.disabled = currentPage <= 1;
          nextBtn.disabled = currentPage >= total;
          zoomLabel.textContent = Math.round(zoom * 100) + "%";
          zoomOutBtn.disabled = zoomIndex() === 0;
          zoomInBtn.disabled = zoomIndex() === ZOOM_STEPS.length - 1;
        }

        function scrollToPage(target) {
          const slot = slots[target - 1];
          if (!slot) return;
          pages.scrollTop +=
            slot.getBoundingClientRect().top -
            pages.getBoundingClientRect().top;
        }

        function goToPage(num) {
          if (!doc || isNaN(num)) return;
          const target = Math.min(Math.max(1, num), doc.numPages);
          if (!slots[target - 1]) return;
          scrollToPage(target);
          currentPage = target;
          // Pages below are still placeholders whose estimated heights shift
          // as they rasterise, which would drag the reader off the page they
          // asked for. Hold the target until the layout around it settles.
          anchorPage = target;
          anchorUntil = Date.now() + 800;
          syncToolbar();
          renderVisible();
        }

        // The page filling most of the viewport is the one the reader is on.
        function updateCurrentPage() {
          if (!slots.length) return;
          // Don't fight a jump that is still settling.
          if (Date.now() < anchorUntil) return;
          const view = pages.getBoundingClientRect();
          const middle = view.top + view.height / 2;
          let page = 1;
          for (let i = 0; i < slots.length; i++) {
            const rect = slots[i].getBoundingClientRect();
            if (rect.top <= middle) page = i + 1;
            else break;
          }
          if (page !== currentPage) {
            currentPage = page;
            syncToolbar();
          }
        }

        // ---------------------------------------------------------------
        // Rendering
        // ---------------------------------------------------------------
        function teardown() {
          generation++;
          if (resizeTimer) {
            clearTimeout(resizeTimer);
            resizeTimer = null;
          }
          if (doc) {
            doc.destroy();
            doc = null;
          }
          slots = [];
          currentPage = 1;
          pages.innerHTML = "";
          syncToolbar();
        }

        function showError() {
          pages.innerHTML = "";
          const msg = document.createElement("div");
          msg.className = "pdf-viewer-error";
          msg.textContent = "This PDF could not be displayed.";
          pages.appendChild(msg);
        }

        function pageWidth() {
          // clientWidth excludes the scrollbar, so the pages never overflow
          // horizontally at 100%.
          const available = Math.max(120, pages.clientWidth - 24);
          return Math.round(Math.min(available, FIT_MAX_WIDTH) * zoom);
        }

        // Match the canvas backing store to the device pixel ratio, else text
        // is visibly soft on HiDPI screens.
        function renderPage(page, slot) {
          const ratio = $window.devicePixelRatio || 1;
          const unscaled = page.getViewport({ scale: 1 });
          const cssWidth = parseFloat(slot.style.width);
          if (!cssWidth) return;
          const viewport = page.getViewport({
            scale: (cssWidth / unscaled.width) * ratio,
          });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = cssWidth + "px";
          canvas.style.height = Math.floor(viewport.height / ratio) + "px";
          slot.innerHTML = "";
          slot.appendChild(canvas);
          // The placeholder height was an estimate; the canvas is now the
          // authority on how tall this page is.
          slot.style.height = "";
          return page.render({
            canvasContext: canvas.getContext("2d"),
            viewport: viewport,
          }).promise;
        }

        function renderVisible() {
          if (!doc) return;
          const myGeneration = generation;
          // Compared in viewport coordinates so this doesn't depend on which
          // ancestor happens to be the slots' offsetParent. clientHeight, not
          // the rect's height, bounds the window: on a hard page load the
          // scroller can be measured before it is clipped, and trusting the
          // rect there would rasterise the whole document at once.
          const view = pages.getBoundingClientRect();
          const top = view.top - PRERENDER_MARGIN;
          const bottom = view.top + pages.clientHeight + PRERENDER_MARGIN;
          slots.forEach(function (slot, i) {
            if (slot.dataset.state) return;
            const rect = slot.getBoundingClientRect();
            if (rect.top > bottom || rect.bottom < top) return;
            slot.dataset.state = "rendering";
            doc
              .getPage(i + 1)
              .then(function (page) {
                if (myGeneration !== generation) return;
                return renderPage(page, slot);
              })
              .then(function () {
                if (myGeneration !== generation) return;
                slot.dataset.state = "done";
                // A real page height replaces an estimate, moving everything
                // below it — re-pin the page the reader asked for.
                if (anchorPage && Date.now() < anchorUntil) {
                  scrollToPage(anchorPage);
                }
                // The shift can also bring further pages into view. Called
                // directly rather than through schedule() so this doesn't
                // depend on a frame callback firing.
                renderVisible();
              })
              .catch(function () {
                // A single unrenderable page shouldn't blank the whole
                // document — leave the placeholder empty and move on.
                slot.dataset.state = "failed";
              });
          });
        }

        function schedule() {
          if (scheduled) return;
          scheduled = true;
          $window.requestAnimationFrame(function () {
            scheduled = false;
            updateCurrentPage();
            renderVisible();
          });
        }

        // Give layout a frame to settle before the first measurement; the
        // timeout is the fallback for occluded tabs, where frame callbacks
        // never run and the reader would otherwise see only placeholders.
        function renderVisibleSoon() {
          let ran = false;
          function once() {
            if (ran) return;
            ran = true;
            renderVisible();
          }
          $window.requestAnimationFrame(once);
          $window.setTimeout(once, 50);
        }

        // Reset every page to a placeholder at the current width, then redraw
        // whatever is on screen. Used for zoom changes and window resizes,
        // both of which invalidate canvases rasterised at the old width.
        function relayout() {
          const width = pageWidth();
          slots.forEach(function (slot) {
            delete slot.dataset.state;
            slot.innerHTML = "";
            slot.style.width = width + "px";
            slot.style.height = Math.round(width / aspect) + "px";
          });
          renderVisible();
        }

        function setZoom(value) {
          if (!doc || value === zoom) return;
          const anchor = currentPage;
          zoom = value;
          syncToolbar();
          relayout();
          goToPage(anchor);
        }

        function onResize() {
          if (!doc) return;
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(function () {
            resizeTimer = null;
            if (doc) relayout();
          }, 250);
        }

        function load(url) {
          teardown();
          if (!url) return;
          const myGeneration = generation;

          pdfjsLib
            .getDocument({
              url: url,
              isEvalSupported: false,
              // Needed for PDFs that reference the 14 standard fonts without
              // embedding them, and for CJK encodings — without these the
              // text silently fails to draw.
              standardFontDataUrl: "/script/external/pdf-standard-fonts/",
              cMapUrl: "/script/external/pdf-cmaps/",
              cMapPacked: true,
            })
            .promise.then(function (_doc) {
              if (myGeneration !== generation) {
                _doc.destroy();
                return;
              }
              doc = _doc;
              // Page 1's shape sizes the placeholders. Without a realistic
              // estimate the scrollbar lies and every page counts as visible.
              return doc.getPage(1).then(function (first) {
                if (myGeneration !== generation) return;
                const v = first.getViewport({ scale: 1 });
                if (v.width && v.height) aspect = v.width / v.height;

                const width = pageWidth();
                for (let i = 1; i <= doc.numPages; i++) {
                  const slot = document.createElement("div");
                  slot.className = "pdf-viewer-page";
                  slot.style.width = width + "px";
                  slot.style.height = Math.round(width / aspect) + "px";
                  pages.appendChild(slot);
                  slots.push(slot);
                }
                syncToolbar();
                renderVisibleSoon();
              });
            })
            .catch(function () {
              if (myGeneration !== generation) return;
              showError();
            });
        }

        pages.addEventListener("scroll", schedule, { passive: true });
        angular.element($window).on("resize", onResize);
        syncToolbar();
        scope.$watch("src", load);
        scope.$on("$destroy", function () {
          pages.removeEventListener("scroll", schedule);
          angular.element($window).off("resize", onResize);
          teardown();
        });
      },
    };
  },
]);
