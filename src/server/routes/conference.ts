import config from "../../config";
import { billingError, billingPlans, isConferencePlan } from "../../core/billing/config";
import { BillingGrant } from "../../core/billing/models";
import { usableGrant } from "../../core/billing/quotas";
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

// The free plan plus one review package per venue size, smallest first.
function conferencePlans() {
  return [
    { id: "free_conference", name: "Free", pricePerRepo: 0, storagePerRepo: -1, repositories: 0, priceId: "",
      description: "<li>Uses each author's allowance</li><li>Conference dashboard</li>" },
    ...billingPlans().filter(p => isConferencePlan(p.id)).map(p => ({ id: p.id as string, name: p.name, pricePerRepo: 0,
      storagePerRepo: p.storage, repositories: p.repositories, priceId: p.priceId,
      description: `<li>Up to ${p.repositories} repositories</li><li>Up to 180 days</li><li>Prepaid at checkout</li>` })),
  ];
}

// With billing enabled every new conference is a paid review package; the free
// plan is only offered on deployments without billing.
export function offeredConferencePlans() {
  if (!config.BILLING_ENABLED) return conferencePlans().filter(p => p.id === "free_conference").map(({ priceId: _, ...p }) => p);
  return conferencePlans().filter(p => isConferencePlan(p.id) && p.priceId).map(({ priceId: _, ...p }) => p);
}

router.get("/plans", async (req: express.Request, res: express.Response) => {
  res.json(offeredConferencePlans());
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
  if (!conf.plan || conferencePlans().filter((p) => p.id == conf.plan.planID).length != 1)
    throw new AnonymousError("invalid_plan", {
      object: conf,
      httpStatus: 400,
    });
  if (!Number.isFinite(new Date(conf.startDate).getTime()) || !Number.isFinite(new Date(conf.endDate).getTime())) throw billingError("conf_start_date_invalid");
  if (isConferencePlan(conf.plan.planID) && ((isNew && (!config.BILLING_ENABLED || !offeredConferencePlans().some(p => p.id === conf.plan.planID))) || new Date(conf.endDate).getTime() - new Date(conf.startDate).getTime() > 180 * 86400_000)) throw billingError("billing_invalid_review_window");
  // A new conference can only use a plan that is offered: paid when billing is on.
  if (isNew && !offeredConferencePlans().some(p => p.id === conf.plan.planID)) throw new AnonymousError("invalid_plan", { object: conf, httpStatus: 400 });
  const plan = conferencePlans().filter((p) => p.id == conf.plan.planID)[0];
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
  if (isNew) model.status = isConferencePlan(body.plan?.planID) ? "pending_payment" : "ready";
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
        if (isConferencePlan(model.plan.planID) && (new Date(req.body.startDate).getTime() !== model.startDate.getTime() || new Date(req.body.endDate).getTime() !== model.endDate.getTime())) throw billingError("billing_review_window_locked");
      }
      // Historical conference plans remain editable without being offered for purchase.
      const legacyPlan = req.params.conferenceID && !offeredConferencePlans().some(p => p.id === model.plan.planID);
      validateConferenceForm(legacyPlan ? { ...req.body, plan: { planID: "free_conference" } } : req.body, !req.params.conferenceID);
      applyConferenceForm(model, req.body, !req.params.conferenceID);

      if (!req.params.conferenceID) {
        model.owners.push(user.model.id);
        model.conferenceID = req.body.conferenceID;

        const chosen = conferencePlans().find((p) => p.id == req.body.plan.planID)!;
        model.plan = {
          planID: chosen.id,
          pricePerRepository: chosen.pricePerRepo,
          quota: { size: chosen.storagePerRepo, file: 0, repository: chosen.repositories },
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
      // Authors see whether the conference pays for their repository's hosting.
      const now = new Date();
      // Mirror admission: a refunded or disputed package no longer hosts anything.
      const hosting = config.BILLING_ENABLED && isConferencePlan(data.plan?.planID) && data.status === "ready" && data.startDate <= now && data.endDate > now
        && (await BillingGrant.find({ scope: `conference:${data.conferenceID}`, revoked: false, until: { $gt: now } }).select("status until revoked").lean()).some(g => usableGrant(g, now));
      try {
        isOwnerOrAdmin(conference.ownerIDs, user);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const o: any = conference.toJSON();
        o.repositories = (await conference.repositories()).map((r) =>
          r.toJSON()
        );
        o.hosting = hosting;
        res.json(o);
      } catch {
        return res.json({
          conferenceID: conference.conferenceID,
          name: conference.name,
          url: conference.url,
          startDate: conference.startDate,
          endDate: conference.endDate,
          options: conference.options,
          hosting,
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
