const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { usableGrant } = require("../src/core/billing/quotas");
const { billingOrigin } = require("../src/core/billing/config");
const config = require("../src/config").default;
const { applyConferenceForm } = require("../src/server/routes/conference");

describe("paid access policy", () => {
  it("requires paid time and rejects revoked, unpaid, cancelled and expired grants", () => {
    const until = new Date(Date.now() + 60000);
    for (const status of ["active", "paid", "past_due"]) expect(usableGrant({ status, until })).to.equal(true);
    for (const status of ["incomplete", "unpaid", "canceled", "paused", "trialing"]) expect(usableGrant({ status, until })).to.equal(false);
    expect(usableGrant({ status: "active", until: new Date(0) })).to.equal(false);
    expect(usableGrant({ status: "active", until, revoked: true })).to.equal(false);
  });
  it("does not activate a paid conference from a submitted form or an edit", () => {
    const model = {};
    const body = { plan: { planID: "conference" }, startDate: "2026-11-01", endDate: "2027-01-01" };
    applyConferenceForm(model, body, true);
    expect(model.status).to.equal("pending_payment");
    applyConferenceForm(model, body, false);
    expect(model.status).to.equal("pending_payment");
    model.status = "removed";
    applyConferenceForm(model, body, false);
    expect(model.status).to.equal("removed");
  });
  it("requires a finite dated expiration when billing is enabled", () => {
    const { validateBillingExpiration } = require("../src/core/billing/expiration");
    const enabled = config.BILLING_ENABLED;
    config.BILLING_ENABLED = true;
    try {
      for (const options of [{}, { expirationMode: "remove" }, { expirationMode: "remove", expirationDate: "invalid" },
        { expirationMode: "remove", expirationDate: "2099-01-01" }]) {
        expect(() => validateBillingExpiration(options)).to.throw("invalid_billing_expiration");
      }
      expect(() => validateBillingExpiration({ expirationMode: "never" })).not.to.throw();
      expect(() => validateBillingExpiration({ expirationMode: "remove", expirationDate: new Date() })).not.to.throw();
    } finally { config.BILLING_ENABLED = enabled; }
  });
  it("rejects unsafe configured redirect origins", () => {
    const original = config.BILLING_ORIGIN;
    try {
      for (const value of ["http://example.org", "https://user:pass@example.org", "https://example.org/path", "https://example.org?next=x"]) {
        config.BILLING_ORIGIN = value;
        expect(() => billingOrigin()).to.throw();
      }
      config.BILLING_ORIGIN = "https://example.org";
      expect(billingOrigin()).to.equal("https://example.org");
    } finally { config.BILLING_ORIGIN = original; }
  });
});

describe("retired conference offers", () => {
  const Model = require("../src/core/model/conference/conferences.model").default;
  const utils = require("../src/server/routes/route-utils");
  const router = require("../src/server/routes/conference").default;
  const save = router.stack.find(layer => layer.route?.path === "/{:conferenceID}" && layer.route.methods.post).route.stack[0].handle;
  const originals = {};
  let model, saves, body;
  beforeEach(() => {
    originals.enabled = config.BILLING_ENABLED; originals.price = config.STRIPE_CONFERENCE_PRICE;
    originals.find = Model.findOne; originals.user = utils.getUser;
    originals.auth = utils.isOwnerOrAdmin; originals.error = utils.handleError;
    config.BILLING_ENABLED = true; config.STRIPE_CONFERENCE_PRICE = "";
    const start = new Date(Date.now() + 86400000), end = new Date(Date.now() + 30 * 86400000);
    saves = 0;
    model = { conferenceID: "CONF", name: "Old", owners: [], status: "ready",
      plan: { planID: "conference" }, startDate: start, endDate: end,
      save: async () => { saves++; } };
    body = { conferenceID: "CONF", name: "New", plan: { planID: "conference" },
      startDate: start.toISOString(), endDate: end.toISOString(), options: { terms: ["Author"] } };
    Model.findOne = async () => model;
    utils.getUser = async () => ({ model: { id: "owner" } });
    utils.isOwnerOrAdmin = () => {};
    utils.handleError = error => { throw error; };
  });
  afterEach(() => {
    config.BILLING_ENABLED = originals.enabled; config.STRIPE_CONFERENCE_PRICE = originals.price;
    Model.findOne = originals.find; utils.getUser = originals.user;
    utils.isOwnerOrAdmin = originals.auth; utils.handleError = originals.error;
  });
  it("saves existing settings without an advertised price", async () => {
    await save({ params: { conferenceID: "CONF" }, body }, { send: () => {} });
    expect(saves).to.equal(1);
    expect(model.name).to.equal("New");
    expect(model.options.terms).to.deep.equal(["Author"]);
    expect(model.status).to.equal("ready");
    expect(model.plan.planID).to.equal("conference");
  });
  for (const change of ["new", "plan", "dates"]) {
    it(`still rejects ${change} purchases or locked changes`, async () => {
      const params = change === "new" ? {} : { conferenceID: "CONF" };
      if (change === "plan") body.plan.planID = "free_conference";
      if (change === "dates") body.endDate = new Date(Date.now() + 60 * 86400000).toISOString();
      let error;
      try { await save({ params, body }, { send: () => {} }); } catch (e) { error = e; }
      expect(error?.message).to.equal(change === "new" ? "billing_invalid_review_window" :
        change === "plan" ? "billing_plan_change_not_supported" : "billing_review_window_locked");
      expect(saves).to.equal(0);
    });
  }
});
