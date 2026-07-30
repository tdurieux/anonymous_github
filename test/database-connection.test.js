require("ts-node/register/transpile-only");
const { expect } = require("chai");

const config = require("../src/config").default;
const { getMongoUrl } = require("../src/server/database");

describe("MongoDB connection configuration", function () {
  const original = {
    MONGODB_URI: config.MONGODB_URI,
    DB_USERNAME: config.DB_USERNAME,
    DB_PASSWORD: config.DB_PASSWORD,
    DB_HOSTNAME: config.DB_HOSTNAME,
  };

  afterEach(function () {
    Object.assign(config, original);
  });

  it("uses a complete replica-set URI when configured", function () {
    const uri =
      "mongodb://user:password@mongo-primary.internal:27017/production" +
      "?authSource=admin&replicaSet=rs0&w=majority";
    config.MONGODB_URI = uri;

    expect(getMongoUrl()).to.equal(uri);
  });

  it("retains the existing single-node connection fallback", function () {
    config.MONGODB_URI = "";
    config.DB_USERNAME = "user";
    config.DB_PASSWORD = "password";
    config.DB_HOSTNAME = "mongodb";

    expect(getMongoUrl()).to.equal(
      "mongodb://user:password@mongodb:27017/production"
    );
  });
});
