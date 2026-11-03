import config from "../../config";
import { billingError } from "../../core/billing/config";
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
  { id: "free_conference", name: "Free", pricePerRepo: 0, storagePerRepo: -1,
    description: "<li>Uses each author's allowance</li><li>Conference dashboard</li>" },
  { id: "conference", name: "Review package", pricePerRepo: 0, storagePerRepo: config.PAID_CONFERENCE_STORAGE,
    description: `<li>Up to ${config.PAID_CONFERENCE_REPOSITORIES} repositories</li><li>Up to 180 days</li><li>Prepaid at checkout</li>` },
];

router.get("/plans", async (req: express.Request, res: express.Response) => {
  res.json(config.BILLING_ENABLED && config.STRIPE_CONFERENCE_PRICE ? plans : plans.filter(p => p.id === "free_conference"));
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
          await conf.expire();
        }
        return conf;
      })
    );
    res.json(conferences.map((conf) => conf.toJSON()));
  } catch (error) {
    handleError(error, res, req);
  }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validateConferenceForm(conf: any, isNew: boolean) {
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
  if (!conf.plan || plans.filter((p) => p.id == conf.plan.planID).length != 1)
    throw new AnonymousError("invalid_plan", {
      object: conf,
      httpStatus: 400,
    });
  if (!Number.isFinite(new Date(conf.startDate).getTime()) || !Number.isFinite(new Date(conf.endDate).getTime())) throw billingError("conf_start_date_invalid");
  if (conf.plan.planID === "conference" && ((isNew && (!config.BILLING_ENABLED || !config.STRIPE_CONFERENCE_PRICE)) || new Date(conf.endDate).getTime() - new Date(conf.startDate).getTime() > 180 * 86400_000)) throw billingError("billing_invalid_review_window");
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

export function applyConferenceForm(
  model: IConferenceDocument,
  body: { name: string; startDate: string | Date; endDate: string | Date; url: string;
    options: IConferenceDocument["options"]; plan?: { planID: string } },
  isNew: boolean
) {
  model.name = body.name;
  model.startDate = new Date(body.startDate);
  model.endDate = new Date(body.endDate);
  if (isNew) model.status = body.plan?.planID === "conference" ? "pending_payment" : "ready";
  model.url = body.url;
  model.options = body.options;
  if (isNew) model.repositories = [];
}

router.post(
  "/{:conferenceID}",
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
      if (req.params.conferenceID) {
        if (req.body.plan?.planID !== model.plan.planID) throw billingError("billing_plan_change_not_supported");
        if (model.plan.planID === "conference" && (new Date(req.body.startDate).getTime() !== model.startDate.getTime() || new Date(req.body.endDate).getTime() !== model.endDate.getTime())) throw billingError("billing_review_window_locked");
      }
      // Historical conference plans remain editable without being offered for purchase.
      const legacyPlan = req.params.conferenceID && !plans.some(p => p.id === model.plan.planID);
      validateConferenceForm(legacyPlan ? { ...req.body, plan: { planID: "free_conference" } } : req.body, !req.params.conferenceID);
      applyConferenceForm(model, req.body, !req.params.conferenceID);

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
            repository: req.body.plan.planID === "conference" ? config.PAID_CONFERENCE_REPOSITORIES : 0,
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const o: any = conference.toJSON();
        o.repositories = (await conference.repositories()).map((r) =>
          r.toJSON()
        );
        res.json(o);
      } catch {
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
