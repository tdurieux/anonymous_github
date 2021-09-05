import * as express from "express";
import config from "../../config";
import Conference from "../Conference";
import AnonymizedRepositoryModel from "../database/anonymizedRepositories/anonymizedRepositories.model";
import ConferenceModel from "../database/conference/conferenes.model";
import Repository from "../Repository";
import { ensureAuthenticated } from "./connection";
import { handleError, getUser } from "./route-utils";

const router = express.Router();

// user needs to be connected for all user API
router.use(ensureAuthenticated);

const plans = [
  {
    id: "free_conference",
    name: "Free",
    pricePerRepo: 0,
    storagePerRepo: -1,
    description: `<li><strong>Quota is deducted from user account</strong></li>
    <li>No-download</li>
    <li>Conference dashboard</li>`,
  },
  {
    id: "premium_conference",
    name: "Premium",
    pricePerRepo: 0.5,
    storagePerRepo: 500,
    description: `<li>500Mo / repository</li>
    <li>Repository download</li>
    <li>Conference dashboard</li>`,
  },
  {
    id: "unlimited_conference",
    name: "Unlimited",
    pricePerRepo: 3,
    storagePerRepo: 0,
    description: `<li><strong>Unlimited</strong> repository size</li>
    <li>Repository download</li>
    <li>Conference dashboard</li>`,
  },
];

router.get("/plans", async (req: express.Request, res: express.Response) => {
  res.json(plans);
});

router.get("/", async (req: express.Request, res: express.Response) => {
  try {
    const user = await getUser(req);
    const conferences = await Promise.all(
      (
        await ConferenceModel.find({
          owners: { $in: user.model.id },
        })
      ).map(async (data) => {
        const conf = new Conference(data);
        if (data.endDate < new Date() && data.status == "ready") {
          await conf.updateStatus("expired");
        }
        return conf;
      })
    );
    res.json(conferences.map((conf) => conf.toJSON()));
  } catch (error) {
    handleError(error, res);
  }
});

function validateConferenceForm(conf) {
  if (!conf.name) throw new Error("conf_name_missing");
  if (!conf.conferenceID) throw new Error("conf_id_missing");
  if (!conf.startDate) throw new Error("conf_start_date_missing");
  if (!conf.endDate) throw new Error("conf_end_date_missing");
  if (new Date(conf.startDate) > new Date(conf.endDate))
    throw new Error("conf_start_date_invalid");
  if (new Date() > new Date(conf.endDate))
    throw new Error("conf_end_date_invalid");
  if (plans.filter((p) => p.id == conf.plan.planID).length != 1)
    throw new Error("invalid_plan");
  const plan = plans.filter((p) => p.id == conf.plan.planID)[0];
  if (plan.pricePerRepo > 0) {
    const billing = conf.billing;
    if (!billing) throw new Error("billing_missing");
    if (!billing.name) throw new Error("billing_name_missing");
    if (!billing.email) throw new Error("billing_email_missing");
    if (!billing.address) throw new Error("billing_address_missing");
    if (!billing.city) throw new Error("billing_city_missing");
    if (!billing.zip) throw new Error("billing_zip_missing");
    if (!billing.country) throw new Error("billing_country_missing");
  }
}

router.post(
  "/:conferenceID?",
  async (req: express.Request, res: express.Response) => {
    try {
      const user = await getUser(req);
      let model = new ConferenceModel();
      if (req.params.conferenceID) {
        model = await ConferenceModel.findOne({
          conferenceID: req.params.conferenceID,
        });
        if (model.owners.indexOf(user.model.id) == -1)
          throw new Error("not_authorized");
      }
      validateConferenceForm(req.body);
      model.name = req.body.name;
      model.startDate = new Date(req.body.startDate);
      model.endDate = new Date(req.body.endDate);
      model.status = "ready";
      model.url = req.body.url;
      model.repositories = [];
      model.options = req.body.options;

      if (!req.params.conferenceID) {
        model.owners.push(user.model.id);
        model.conferenceID = req.body.conferenceID;

        model.plan = {
          planID: req.body.plan.planID,
          pricePerRepository: plans.filter(
            (p) => p.id == req.body.plan.planID
          )[0].pricePerRepo,
          quota: {
            size: plans.filter((p) => p.id == req.body.plan.planID)[0]
              .storagePerRepo,
            file: 0,
            repository: 0,
          },
        };

        if (req.body.billing)
          model.billing = {
            name: req.body.billing.name,
            email: req.body.billing.email,
            address: req.body.billing.address,
            address2: req.body.billing.address2,
            city: req.body.billing.city,
            zip: req.body.billing.zip,
            country: req.body.billing.country,
            vat: req.body.billing.vat,
          };
      }
      await model.save();

      res.send("ok");
    } catch (error) {
      if (error.message?.indexOf(" duplicate key") > -1) {
        return handleError(new Error("conf_id_used"), res);
      }
      handleError(error, res);
    }
  }
);

router.get(
  "/:conferenceID",
  async (req: express.Request, res: express.Response) => {
    try {
      const user = await getUser(req);
      const data = await ConferenceModel.findOne({
        conferenceID: req.params.conferenceID,
      });
      if (!data) throw new Error("conf_not_found");
      const conference = new Conference(data);
      if (conference.ownerIDs.indexOf(user.model.id) == -1)
        throw new Error("not_authorized");
      const o: any = conference.toJSON();
      o.repositories = (await conference.repositories()).map((r) => r.toJSON());
      res.json(o);
    } catch (error) {
      handleError(error, res);
    }
  }
);

router.delete(
  "/:conferenceID",
  async (req: express.Request, res: express.Response) => {
    try {
      const user = await getUser(req);
      const data = await ConferenceModel.findOne({
        conferenceID: req.params.conferenceID,
      });
      if (!data) throw new Error("conf_not_found");
      const conference = new Conference(data);
      if (conference.ownerIDs.indexOf(user.model.id) == -1)
        throw new Error("not_authorized");
      await conference.remove();
      res.send("ok");
    } catch (error) {
      handleError(error, res);
    }
  }
);

export default router;
