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
