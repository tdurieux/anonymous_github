import * as express from "express";
import AnonymousError from "../../core/AnonymousError";
import Conference from "../../core/Conference";
import ConferenceModel from "../../core/model/conference/conferences.model";
import { ensureAuthenticated } from "./connection";
import { handleError, getUser, isOwnerOrAdmin } from "./route-utils";
import { IConferenceDocument } from "../../core/model/conference/conferences.types";

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
    storagePerRepo: 500 * 8 * 1024,
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
    handleError(error, res, req);
  }
});

function validateConferenceForm(conf: any) {
  if (!conf.name)
    throw new AnonymousError("conf_name_missing", {
      object: conf,
      httpStatus: 400,
    });
  if (!conf.conferenceID)
    throw new AnonymousError("conf_id_missing", {
      object: conf,
      httpStatus: 400,
    });
  if (!conf.startDate)
    throw new AnonymousError("conf_start_date_missing", {
      object: conf,
      httpStatus: 400,
    });
  if (!conf.endDate)
    throw new AnonymousError("conf_end_date_missing", {
      object: conf,
      httpStatus: 400,
    });
  if (new Date(conf.startDate) > new Date(conf.endDate))
    throw new AnonymousError("conf_start_date_invalid", {
      object: conf,
      httpStatus: 400,
    });
  if (new Date() > new Date(conf.endDate))
    throw new AnonymousError("conf_end_date_invalid", {
      object: conf,
      httpStatus: 400,
    });
  if (plans.filter((p) => p.id == conf.plan.planID).length != 1)
    throw new AnonymousError("invalid_plan", {
      object: conf,
      httpStatus: 400,
    });
  const plan = plans.filter((p) => p.id == conf.plan.planID)[0];
  if (plan.pricePerRepo > 0) {
    const billing = conf.billing;
    if (!billing)
      throw new AnonymousError("billing_missing", {
        object: conf,
        httpStatus: 400,
      });
    if (!billing.name)
      throw new AnonymousError("billing_name_missing", {
        object: conf,
        httpStatus: 400,
      });
    if (!billing.email)
      throw new AnonymousError("billing_email_missing", {
        object: conf,
        httpStatus: 400,
      });
    if (!billing.address)
      throw new AnonymousError("billing_address_missing", {
        object: conf,
        httpStatus: 400,
      });
    if (!billing.city)
      throw new AnonymousError("billing_city_missing", {
        object: conf,
        httpStatus: 400,
      });
    if (!billing.zip)
      throw new AnonymousError("billing_zip_missing", {
        object: conf,
        httpStatus: 400,
      });
    if (!billing.country)
      throw new AnonymousError("billing_country_missing", {
        object: conf,
        httpStatus: 400,
      });
  }
}

router.post(
  "/:conferenceID?",
  async (req: express.Request, res: express.Response) => {
    try {
      const user = await getUser(req);
      let model: IConferenceDocument = new ConferenceModel();
      if (req.params.conferenceID) {
        const queryModel = await ConferenceModel.findOne({
          conferenceID: req.params.conferenceID,
        });
        if (!queryModel) {
          throw new AnonymousError("conference_not_found", {
            httpStatus: 404,
          });
        }
        model = queryModel;
        isOwnerOrAdmin(model.owners, user);
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
      if (
        error instanceof Error &&
        error.message?.indexOf(" duplicate key") > -1
      ) {
        return handleError(
          new AnonymousError("conf_id_used", {
            object: req.params.conferenceID,
            httpStatus: 400,
          }),
          res
        );
      }
      handleError(error, res, req);
    }
  }
);

router.get(
  "/:conferenceID",
  async (req: express.Request, res: express.Response) => {
    try {
      const data = await ConferenceModel.findOne({
        conferenceID: req.params.conferenceID,
      });
      if (!data)
        throw new AnonymousError("conf_not_found", {
          object: req.params.conferenceID,
          httpStatus: 404,
        });
      const user = await getUser(req);
      const conference = new Conference(data);
      try {
        isOwnerOrAdmin(conference.ownerIDs, user);
        const o: any = conference.toJSON();
        o.repositories = (await conference.repositories()).map((r) =>
          r.toJSON()
        );
        res.json(o);
      } catch (error) {
        return res.json({
          conferenceID: conference.conferenceID,
          name: conference.name,
          url: conference.url,
          startDate: conference.startDate,
          endDate: conference.endDate,
          options: conference.options,
        });
      }
    } catch (error) {
      handleError(error, res, req);
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
      if (!data)
        throw new AnonymousError("conf_not_found", {
          object: req.params.conferenceID,
          httpStatus: 400,
        });
      const conference = new Conference(data);
      isOwnerOrAdmin(conference.ownerIDs, user);
      await conference.remove();
      res.send("ok");
    } catch (error) {
      handleError(error, res, req);
    }
  }
);

export default router;
