import * as express from "express";
import { ContentAnonimizer } from "../../core/anonymize-utils";
import { handleError } from "./route-utils";
import { ensureAuthenticated } from "./connection";

const router = express.Router();
router.use(ensureAuthenticated);

// Anonymize one or more snippets of content with the same logic the backend
// uses on real anonymized files. The form's preview was running a duplicate
// of ContentAnonimizer in the browser, which drifted from the backend (missed
// fixes for word boundaries, accent matching, custom replacements, etc.).
// Routing the preview through this endpoint keeps the two in lockstep.
//
// Accepts either { content: string } (single) or { contents: string[] }
// (batch) so the PR preview can scrub many fields in one round trip.
router.post("/", async (req: express.Request, res: express.Response) => {
  try {
    const body: {
      content?: unknown;
      contents?: unknown;
      options?: {
        terms?: string[];
        image?: boolean;
        link?: boolean;
        repoName?: string;
        branchName?: string;
        repoId?: string;
      };
    } = req.body || {};

    let inputs: string[];
    let single = false;
    if (typeof body.content === "string") {
      inputs = [body.content];
      single = true;
    } else if (
      Array.isArray(body.contents) &&
      body.contents.every((c) => typeof c === "string")
    ) {
      inputs = body.contents as string[];
    } else {
      return res.status(400).json({ error: "missing_content" });
    }

    const opt = body.options || {};
    // Construct one anonymizer per snippet so the wasAnonymized flag is per
    // input. ContentAnonimizer is cheap to instantiate.
    const outputs = inputs.map((content) => {
      const a = new ContentAnonimizer({
        terms: Array.isArray(opt.terms) ? opt.terms : [],
        image: opt.image,
        link: opt.link,
        repoName: opt.repoName,
        branchName: opt.branchName,
        repoId: opt.repoId,
      });
      return a.anonymize(content);
    });

    if (single) {
      return res.json({ content: outputs[0] });
    }
    res.json({ contents: outputs });
  } catch (error) {
    handleError(error, res, req);
  }
});

export default router;
