import * as express from "express";
import { ensureAuthenticated } from "./connection";

import { getGist, getUser, handleError, isOwnerOrAdmin } from "./route-utils";
import AnonymousError from "../../core/AnonymousError";
import { IAnonymizedGistDocument } from "../../core/model/anonymizedGists/anonymizedGists.types";
import Gist from "../../core/Gist";
import AnonymizedGistModel from "../../core/model/anonymizedGists/anonymizedGists.model";
import { RepositoryStatus } from "../../core/types";

const router = express.Router();

// user needs to be connected for all user API
router.use(ensureAuthenticated);

// refresh gist
router.post(
  "/:gistId/refresh",
  async (req: express.Request, res: express.Response) => {
    try {
      const gist = await getGist(req, res, { nocheck: true });
      if (!gist) return;

      const user = await getUser(req);
      isOwnerOrAdmin([gist.owner.id], user);
      await gist.updateIfNeeded({ force: true });
      res.json({ status: gist.status });
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

// delete a gist
router.delete(
  "/:gistId/",
  async (req: express.Request, res: express.Response) => {
    const gist = await getGist(req, res, { nocheck: true });
    if (!gist) return;
    try {
      if (gist.status == "removed")
        throw new AnonymousError("is_removed", {
          object: req.params.gistId,
          httpStatus: 410,
        });
      const user = await getUser(req);
      isOwnerOrAdmin([gist.owner.id], user);
      await gist.remove();
      return res.json({ status: gist.status });
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

// fetch GitHub gist details (used by anonymize form)
router.get(
  "/source/:gistId",
  async (req: express.Request, res: express.Response) => {
    const user = await getUser(req);
    try {
      const gist = new Gist(
        new AnonymizedGistModel({
          owner: user.id,
          source: {
            gistId: req.params.gistId,
          },
        })
      );
      gist.owner = user;
      await gist.download();
      res.json(gist.toJSON());
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

// get gist information
router.get(
  "/:gistId/",
  async (req: express.Request, res: express.Response) => {
    try {
      const gist = await getGist(req, res, { nocheck: true });
      if (!gist) return;

      const user = await getUser(req);
      isOwnerOrAdmin([gist.owner.id], user);
      res.json(gist.toJSON());
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validateNewGist(gistUpdate: any): void {
  const validCharacters = /^[0-9a-zA-Z\-_]+$/;
  if (
    !gistUpdate.gistId ||
    !gistUpdate.gistId.match(validCharacters) ||
    gistUpdate.gistId.length < 3
  ) {
    throw new AnonymousError("invalid_gistId", {
      object: gistUpdate,
      httpStatus: 400,
    });
  }
  if (!gistUpdate.source || !gistUpdate.source.gistId) {
    throw new AnonymousError("gistId_not_specified", {
      object: gistUpdate,
      httpStatus: 400,
    });
  }
  if (!gistUpdate.options) {
    throw new AnonymousError("options_not_provided", {
      object: gistUpdate,
      httpStatus: 400,
    });
  }
  if (!Array.isArray(gistUpdate.terms)) {
    throw new AnonymousError("invalid_terms_format", {
      object: gistUpdate,
      httpStatus: 400,
    });
  }
}

function updateGistModel(
  model: IAnonymizedGistDocument,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gistUpdate: any
) {
  model.options = {
    terms: gistUpdate.terms,
    expirationMode: gistUpdate.options.expirationMode,
    expirationDate: gistUpdate.options.expirationDate
      ? new Date(gistUpdate.options.expirationDate)
      : undefined,
    update: gistUpdate.options.update,
    image: gistUpdate.options.image,
    link: gistUpdate.options.link,
    body: gistUpdate.options.body,
    title: gistUpdate.options.title,
    username: gistUpdate.options.username,
    origin: gistUpdate.options.origin,
    content: gistUpdate.options.content,
    comments: gistUpdate.options.comments,
    date: gistUpdate.options.date,
  };
}

// update a gist
router.post(
  "/:gistId/",
  async (req: express.Request, res: express.Response) => {
    try {
      const gist = await getGist(req, res, { nocheck: true });
      if (!gist) return;
      const user = await getUser(req);

      isOwnerOrAdmin([gist.owner.id], user);
      const gistUpdate = req.body;
      validateNewGist(gistUpdate);
      gist.model.anonymizeDate = new Date();

      updateGistModel(gist.model, gistUpdate);
      gist.model.conference = gistUpdate.conference;
      await gist.updateStatus(RepositoryStatus.PREPARING);
      await gist.updateIfNeeded({ force: true });
      res.json(gist.toJSON());
    } catch (error) {
      return handleError(error, res, req);
    }
  }
);

// add gist
router.post("/", async (req: express.Request, res: express.Response) => {
  const user = await getUser(req);
  const gistUpdate = req.body;

  try {
    validateNewGist(gistUpdate);

    const gist = new Gist(
      new AnonymizedGistModel({
        owner: user.id,
        options: gistUpdate.options,
      })
    );

    gist.model.gistId = gistUpdate.gistId;
    gist.model.anonymizeDate = new Date();
    gist.model.owner = user.id;

    updateGistModel(gist.model, gistUpdate);
    gist.source.accessToken = user.accessToken;
    gist.source.gistId = gistUpdate.source.gistId;

    gist.model.conference = gistUpdate.conference;

    await gist.anonymize();
    res.send(gist.toJSON());
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.indexOf(" duplicate key") > -1
    ) {
      return handleError(
        new AnonymousError("gistId_already_used", {
          httpStatus: 400,
          cause: error,
          object: gistUpdate,
        }),
        res,
        req
      );
    }
    return handleError(error, res, req);
  }
});

export default router;
