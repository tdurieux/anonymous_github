const { expect } = require("chai");
require("ts-node/register/transpile-only");

const {
  getLoginToken,
  isDisabledAccount,
} = require("../src/server/routes/auth-utils");

describe("auth-utils.getLoginToken", function () {
  it("accepts a bearer token", function () {
    expect(
      getLoginToken({ headers: { authorization: "Bearer secret" }, body: {} })
    ).to.equal("secret");
  });

  it("accepts a token in the request body", function () {
    expect(getLoginToken({ headers: {}, body: { token: "secret" } })).to.equal(
      "secret"
    );
  });

  it("does not inspect query-string credentials", function () {
    expect(
      getLoginToken({ headers: {}, body: {}, query: { token: "leaked" } })
    ).to.equal(null);
  });

  it("rejects empty body tokens", function () {
    expect(getLoginToken({ headers: {}, body: { token: "  " } })).to.equal(
      null
    );
  });
});

describe("login-token route", function () {
  it("only accepts POST requests", function () {
    const { router } = require("../src/server/routes/connection");
    const layer = router.stack.find(
      (candidate) => candidate.route?.path === "/login-token"
    );
    expect(layer).to.not.equal(undefined);
    expect(layer.route.methods).to.deep.equal({ post: true });
  });
});

describe("auth-utils.isDisabledAccount", function () {
  it("rejects banned and removed accounts", function () {
    expect(isDisabledAccount("banned")).to.equal(true);
    expect(isDisabledAccount("removed")).to.equal(true);
  });

  it("allows active and legacy accounts", function () {
    expect(isDisabledAccount("active")).to.equal(false);
    expect(isDisabledAccount(undefined)).to.equal(false);
  });
});
