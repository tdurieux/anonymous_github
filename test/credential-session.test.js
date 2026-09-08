const { expect } = require("chai");
require("ts-node/register/transpile-only");
const passport = require("passport");
require("../src/server/routes/connection");

describe("credential-free sessions", () => {
  it("serializes only the owner ID", done => {
    passport.serializeUser({ user: { _id: "507f1f77bcf86cd799439011", accessTokens: { github: "secret" } }, accessToken: "secret" }, (error, value) => {
      expect(error).to.equal(null);
      expect(value).to.equal("507f1f77bcf86cd799439011");
      done();
    });
  });
  it("rejects the legacy session object", done => {
    passport.deserializeUser({ user: { _id: "507f1f77bcf86cd799439011" }, accessToken: "secret" }, (error, value) => {
      expect(error).to.equal(null);
      expect(value).to.equal(false);
      done();
    });
  });
});
