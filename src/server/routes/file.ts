import * as express from "express";
import AnonymizedFile from "../../core/AnonymizedFile";
import AnonymousError from "../../core/AnonymousError";
import { getRepo, handleError } from "./route-utils";
import { fileETag } from "./file-etag";

export const router = express.Router();

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    try {
      return decodeURI(segment);
    } catch {
      return segment;
    }
  }
}

// Extensions the browser will execute script from when it renders the
// response as a document (directly, or via the "Raw" action).
const SCRIPTABLE_EXTENSIONS = new Set([
  "html",
  "htm",
  "xhtml",
  "xht",
  "svg",
  "xml",
  "xsl",
  "xslt",
  "mhtml",
]);

export function isScriptableDocument(anonymizedPath: string): boolean {
  const name = anonymizedPath.substring(anonymizedPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return SCRIPTABLE_EXTENSIONS.has(name.substring(dot + 1).toLowerCase());
}

export function filePathFromRequestUrl(
  reqUrl: string,
  protocol: string,
  hostname: string,
  repoId: string
): string {
  const pathname = new URL(reqUrl, `${protocol}://${hostname}`).pathname;
  const prefix = `/${encodeURIComponent(repoId)}/file/`;
  const rawPath = pathname.startsWith(prefix)
    ? pathname.substring(prefix.length)
    : pathname.replace(`/${repoId}/file/`, "");
  return rawPath.split("/").map(decodePathSegment).join("/");
}

router.get(
  "/:repoId/file/:path*",
  async (req: express.Request, res: express.Response) => {
    const anonymizedPath = filePathFromRequestUrl(
      req.url,
      req.protocol,
      req.hostname,
      req.params.repoId
    );
    if (anonymizedPath.endsWith("/")) {
      return handleError(
        new AnonymousError("folder_not_supported", {
          httpStatus: 404,
          object: anonymizedPath,
        }),
        res
      );
    }
    // Reject path traversal before the path reaches the storage layer. The
    // storage backends also validate, but failing fast here keeps a crafted
    // "../" URL from being treated as a real lookup (CWE-22/25).
    if (
      anonymizedPath
        .split(/[\\/]/)
        .some((segment) => segment === "..") ||
      /^[\\/]/.test(anonymizedPath)
    ) {
      return handleError(
        new AnonymousError("invalid_path", {
          httpStatus: 400,
          object: anonymizedPath,
        }),
        res
      );
    }

    const repo = await getRepo(req, res, {
      nocheck: false,
    });
    if (!repo) return;

    try {
      if (!(await repo.isReady())) {
        throw new AnonymousError("repository_not_ready", {
          object: repo,
          httpStatus: 425,
        });
      }
      const f = new AnonymizedFile({
        repository: repo,
        anonymizedPath,
      });
      if (!f.isFileSupported()) {
        throw new AnonymousError("file_not_supported", {
          httpStatus: 403,
          object: f,
        });
      }
      if (req.query.download) {
        res.attachment(
          anonymizedPath.substring(anonymizedPath.lastIndexOf("/") + 1)
        );
      } else if (isScriptableDocument(anonymizedPath)) {
        // A repository's own .html/.svg is untrusted content served from our
        // origin: opening it renders it as a document, and any script in it
        // would run as the site itself (session cookie, same-origin fetches
        // against /api). The CSP sandbox directive forces the response into an
        // opaque origin, so the document still renders but can reach nothing
        // of ours. Scripts are left out entirely, matching the file viewer's
        // default (html-doc.js) — a reader who wants them opts in there.
        // allow-same-origin must never be added: combined with allow-scripts
        // it lets the document remove its own sandbox.
        res.header(
          "Content-Security-Policy",
          "sandbox allow-popups allow-forms allow-modals"
        );
      }
      const etag = fileETag(
        req.query.v as string | undefined,
        anonymizedPath,
        repo.model.options
      );
      res.header("ETag", etag);
      // Force the browser to revalidate every time. The previous 210-day
      // max-age was keyed only on the upstream sha, so editing the
      // anonymization term list left old anonymizations cached under the
      // same URL.
      res.header("Cache-Control", "private, no-cache, must-revalidate");
      if (req.headers["if-none-match"] === etag) {
        return res.status(304).end();
      }
      await f.send(res);
      await repo.countView();
    } catch (error) {
      return handleError(error, res, req);
    }
  }
);

export default router;
