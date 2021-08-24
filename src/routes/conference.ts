import * as express from "express";
import config from "../../config";
import AnonymizedRepositoryModel from "../database/anonymizedRepositories/anonymizedRepositories.model";
import ConferenceModel from "../database/conference/conferenes.model";
import { ensureAuthenticated } from "./connection";
import { handleError, getUser } from "./route-utils";

const router = express.Router();

// user needs to be connected for all user API
router.use(ensureAuthenticated);

router.get("/", async (req: express.Request, res: express.Response) => {
  try {
    const user = await getUser(req);
    const conferences = await ConferenceModel.find({
      owners: { $in: user.model.id },
    });
    res.json(conferences);
  } catch (error) {
    handleError(error, res);
  }
});

router.post("/", async (req: express.Request, res: express.Response) => {
  try {
    const user = await getUser(req);
    const model = new ConferenceModel();
    model.name = req.body.name;
    model.conferenceID = req.body.conferenceID;
    model.start = new Date(req.body.startDate);
    model.end = new Date(req.body.endDate);
    model.status = "ready";
    model.options = req.body.options;
    model.owners.push(user.model.id);
    await model.save();
    res.send("ok");
  } catch (error) {
    handleError(error, res);
  }
});

router.get(
  "/:conferenceID",
  async (req: express.Request, res: express.Response) => {
    try {
      const user = await getUser(req);
      const conference = await ConferenceModel.findOne({
        conferenceID: req.params.conferenceID,
      });
      if (conference.owners.indexOf(user.model.id) == -1)
        throw new Error("not_authorized");
      const repositories = await AnonymizedRepositoryModel.find({
        conference: conference.conferenceID,
      });
      res.json({
        repositories,
        conference,
      });
    } catch (error) {
      handleError(error, res);
    }
  }
);

export default router;
