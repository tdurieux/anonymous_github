export const humanFileSize = value => window.humanFileSize(value);
export const bigNum = (function () {
    return function bigNum(v) {
      const n = Number(v) || 0;
      const abs = Math.abs(n);
      if (abs < 1000) return String(n);
      if (abs < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
      if (abs < 1000000) return Math.round(n / 1000) + "k";
      if (abs < 10000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
      return Math.round(n / 1000000) + "M";
    };
  })();
export const humanTime = (function () {
    return function humanTime(seconds) {
      if (!seconds) {
        return "never";
      }
      if (seconds instanceof Date)
        seconds = Math.round((Date.now() - seconds) / 1000);
      if (typeof seconds == "string" || typeof seconds == "number")
        seconds = Math.round((Date.now() - new Date(seconds)) / 1000);
      var suffix = seconds < 0 ? "from now" : "ago";

      // more than 2 days ago display Date. Spell the month out so the date
      // is unambiguous regardless of the reader's locale (9/6 vs 6/9).
      if (Math.abs(seconds) > 2 * 60 * 60 * 24) {
        const now = new Date();
        now.setSeconds(now.getSeconds() - seconds);
        return (
          "on " +
          now.toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
            year: "numeric",
          })
        );
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
  })();
export const title = (function () {
    return function (str) {
      if (!str) return str;

      str = str.toLowerCase();
      var words = str.split(" ");

      var capitalized = words.map(function (word) {
        return word.charAt(0).toUpperCase() + word.substring(1, word.length);
      });
      return capitalized.join(" ");
    };
  })();
export const statusLabel = (function () {
    var labels = {
      ready: "Ready",
      error: "Error",
      expired: "Expired",
      expiring: "Expiring",
      removed: "Removed",
      removing: "Removing",
      queue: "Queued",
      download: "Downloading",
      downloaded: "Downloaded",
      preparing: "Preparing",
      anonymizing: "Anonymizing",
    };
    return function (status) {
      if (!status) return "";
      if (labels[status]) return labels[status];
      var s = String(status).replace(/[_-]+/g, " ").toLowerCase();
      return s.charAt(0).toUpperCase() + s.slice(1);
    };
  })();
export const statusMsg = (function () {
    // Known machine codes → sentences. Unknown snake_case codes are
    // converted to a sentence instead of leaking `branch_not_found`.
    var codes = {
      branch_not_found: "Branch not found on GitHub",
      repo_not_found: "Repository not found on GitHub",
      repository_not_found: "Repository not found on GitHub",
      repo_not_accessible: "Repository is not accessible with your token",
      pr_not_found: "Pull request not found on GitHub",
      gist_not_found: "Gist not found on GitHub",
      commit_not_found: "Commit not found on GitHub",
      repo_too_big: "Repository exceeds the size limit",
      quota_exceeded: "Storage quota exceeded",
      incomplete_record: "Incomplete record: missing identifier",
    };
    return function (msg) {
      if (!msg) return msg;
      var m = msg.match(/^rate_limited:(\d+)$/);
      if (m) {
        var remaining = Math.max(0, Math.ceil((parseInt(m[1], 10) - Date.now()) / 1000));
        if (remaining <= 0) return "Rate limited — resuming soon";
        var min = Math.floor(remaining / 60);
        var sec = remaining % 60;
        return "Rate limited — retrying in " + (min > 0 ? min + "m " + sec + "s" : sec + "s");
      }
      if (codes[msg]) return codes[msg];
      if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(msg)) {
        var s = msg.replace(/_/g, " ");
        return s.charAt(0).toUpperCase() + s.slice(1);
      }
      return msg;
    };
  })();
export const diff = (function (html) {
      const esc = (s) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

      function flushFile(out, file) {
        if (!file) return;
        const headerName =
          file.newPath && file.newPath !== "/dev/null"
            ? file.newPath
            : file.oldPath || "";
        const status =
          file.oldPath === "/dev/null"
            ? "added"
            : file.newPath === "/dev/null"
            ? "deleted"
            : file.oldPath && file.newPath && file.oldPath !== file.newPath
            ? "renamed"
            : "modified";
        out.push('<div class="diff-file-block">');
        out.push(
          '<div class="diff-file-header"><span class="diff-file-icon"><i class="far fa-file-code"></i></span>' +
            '<span class="diff-file-name">' +
            esc(headerName) +
            "</span>" +
            '<span class="diff-file-status diff-file-status-' +
            status +
            '">' +
            status +
            "</span></div>"
        );
        if (file.lines.length) {
          out.push('<table class="diff-file-table"><tbody>');
          for (const line of file.lines) {
            out.push(
              '<tr class="diff-row diff-row-' +
                line.kind +
                '">' +
                '<td class="diff-gutter diff-gutter-old">' +
                (line.oldNo || "") +
                "</td>" +
                '<td class="diff-gutter diff-gutter-new">' +
                (line.newNo || "") +
                "</td>" +
                '<td class="diff-sign">' +
                (line.kind === "add"
                  ? "+"
                  : line.kind === "remove"
                  ? "-"
                  : line.kind === "hunk"
                  ? "@"
                  : "") +
                "</td>" +
                '<td class="diff-code">' +
                esc(line.text) +
                "</td>" +
                "</tr>"
            );
          }
          out.push("</tbody></table>");
        }
        out.push("</div>");
      }

      return function (str) {
        if (!str) return str;
        const out = [];
        let file = null;
        let oldNo = 0;
        let newNo = 0;
        const ensureFile = () => {
          if (!file) file = { oldPath: "", newPath: "", lines: [] };
          return file;
        };
        const startNewFileIfNeeded = () => {
          if (file && (file.lines.length || file.oldPath || file.newPath)) {
            flushFile(out, file);
            file = null;
          }
        };
        const lines = str.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i];
          if (ln.startsWith("diff --git")) {
            startNewFileIfNeeded();
            ensureFile();
            continue;
          }
          if (ln.startsWith("--- ")) {
            // New file boundary if the previous file already had lines.
            if (file && file.lines.length) startNewFileIfNeeded();
            ensureFile().oldPath = ln.replace(/^--- (a\/)?/, "").trim();
            continue;
          }
          if (ln.startsWith("+++ ")) {
            ensureFile().newPath = ln.replace(/^\+\+\+ (b\/)?/, "").trim();
            continue;
          }
          if (
            ln.startsWith("index ") ||
            ln.startsWith("similarity index") ||
            ln.startsWith("rename ") ||
            ln.startsWith("new file mode") ||
            ln.startsWith("deleted file mode") ||
            ln.startsWith("Binary files")
          ) {
            continue;
          }
          if (ln.startsWith("@@")) {
            const m = ln.match(/@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
            if (m) {
              oldNo = parseInt(m[1], 10);
              newNo = parseInt(m[2], 10);
            }
            ensureFile().lines.push({ kind: "hunk", oldNo: "", newNo: "", text: ln });
            continue;
          }
          if (!file) continue;
          if (ln.startsWith("+")) {
            file.lines.push({ kind: "add", oldNo: "", newNo: newNo, text: ln.slice(1) });
            newNo++;
          } else if (ln.startsWith("-")) {
            file.lines.push({ kind: "remove", oldNo: oldNo, newNo: "", text: ln.slice(1) });
            oldNo++;
          } else {
            file.lines.push({ kind: "ctx", oldNo: oldNo, newNo: newNo, text: ln.startsWith(" ") ? ln.slice(1) : ln });
            oldNo++;
            newNo++;
          }
        }
        flushFile(out, file);
        return out.join("");
      };
    })({ trustAsHtml: value => value });

export function number(value, digits) {
  return value == null ? "" : Number(value).toLocaleString(undefined, digits == null ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function uppercase(value) { return String(value ?? "").toUpperCase(); }
export function limitTo(value, count, start = 0) { return (value || []).slice(start, start + count); }
export function filter(values, predicate) {
  if (!Array.isArray(values)) return [];
  if (typeof predicate === "function") return values.filter(predicate);
  return values;
}
export function orderBy(values, expression) {
  if (!expression) return values || [];
  const keys = Array.isArray(expression) ? expression : [expression];
  return [...(values || [])].sort((a, b) => {
    for (let key of keys) {
      const direction = key[0] === "-" ? -1 : 1;
      key = key.replace(/^[+-]/, "");
      let av = key.split(".").reduce((o, p) => o?.[p], a);
      let bv = key.split(".").reduce((o, p) => o?.[p], b);
      if (typeof av === "string") av = av.toLowerCase();
      if (typeof bv === "string") bv = bv.toLowerCase();
      if (av !== bv) return (av == null ? -1 : bv == null ? 1 : av < bv ? -1 : 1) * direction;
    }
    return 0;
  });
}
export function date(value, format) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d)) return String(value);
  if (!format || format === "mediumDate") return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const parts = { yyyy: d.getFullYear(), MMM: d.toLocaleDateString(undefined, { month: "short" }), MM: String(d.getMonth() + 1).padStart(2, "0"), dd: String(d.getDate()).padStart(2, "0"), d: d.getDate(), HH: String(d.getHours()).padStart(2, "0"), mm: String(d.getMinutes()).padStart(2, "0"), ss: String(d.getSeconds()).padStart(2, "0") };
  return format.replace(/yyyy|MMM|MM|dd|HH|mm|ss|d/g, token => parts[token]);
}
export function plural(count, forms) {
  return (forms?.[count] ?? forms?.[count === 1 ? "one" : "other"] ?? "").replace(/\{\}/g, count ?? 0);
}
