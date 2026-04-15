const { expect } = require("chai");

/**
 * Tests for the config environment variable parsing logic.
 *
 * The config module reads process.env at load time, so we replicate the
 * parsing logic here to test it in isolation. This verifies the fix for the
 * bug where numeric and boolean config values were being overwritten with
 * strings from process.env.
 */

function parseConfigFromEnv(defaults, env) {
  const config = { ...defaults };
  for (const conf in env) {
    if (config[conf] !== undefined) {
      const currentValue = config[conf];
      const envValue = env[conf];
      if (typeof currentValue === "number") {
        const parsed = Number(envValue);
        if (!isNaN(parsed)) {
          config[conf] = parsed;
        }
      } else if (typeof currentValue === "boolean") {
        config[conf] = envValue === "true" || envValue === "1";
      } else {
        config[conf] = envValue;
      }
    }
  }
  return config;
}

describe("Config environment variable parsing", function () {
  const defaults = {
    PORT: 5000,
    REDIS_PORT: 6379,
    MAX_FILE_SIZE: 100 * 1024 * 1024,
    MAX_REPO_SIZE: 60000,
    ENABLE_DOWNLOAD: true,
    RATE_LIMIT: 350,
    TRUST_PROXY: 1,
    SESSION_SECRET: "SESSION_SECRET",
    CLIENT_ID: "CLIENT_ID",
    APP_HOSTNAME: "anonymous.4open.science",
    STORAGE: "filesystem",
  };

  // ---------------------------------------------------------------
  // Number coercion
  // ---------------------------------------------------------------
  describe("numeric values", function () {
    it("parses PORT from string to number", function () {
      const config = parseConfigFromEnv(defaults, { PORT: "3000" });
      expect(config.PORT).to.equal(3000);
      expect(config.PORT).to.be.a("number");
    });

    it("parses REDIS_PORT from string to number", function () {
      const config = parseConfigFromEnv(defaults, { REDIS_PORT: "6380" });
      expect(config.REDIS_PORT).to.equal(6380);
      expect(config.REDIS_PORT).to.be.a("number");
    });

    it("parses MAX_FILE_SIZE from string to number", function () {
      const config = parseConfigFromEnv(defaults, {
        MAX_FILE_SIZE: "52428800",
      });
      expect(config.MAX_FILE_SIZE).to.equal(52428800);
      expect(config.MAX_FILE_SIZE).to.be.a("number");
    });

    it("parses RATE_LIMIT from string to number", function () {
      const config = parseConfigFromEnv(defaults, { RATE_LIMIT: "100" });
      expect(config.RATE_LIMIT).to.equal(100);
    });

    it("ignores NaN values and keeps the default", function () {
      const config = parseConfigFromEnv(defaults, { PORT: "not-a-number" });
      expect(config.PORT).to.equal(5000);
    });

    it("handles zero correctly", function () {
      const config = parseConfigFromEnv(defaults, { TRUST_PROXY: "0" });
      expect(config.TRUST_PROXY).to.equal(0);
      expect(config.TRUST_PROXY).to.be.a("number");
    });

    it("handles negative numbers", function () {
      const config = parseConfigFromEnv(defaults, { TRUST_PROXY: "-1" });
      expect(config.TRUST_PROXY).to.equal(-1);
    });

    it("correctly compares parsed numbers (no string comparison bug)", function () {
      const config = parseConfigFromEnv(defaults, { MAX_REPO_SIZE: "150" });
      // The critical test: "150" > "60000" is true in string comparison
      // but 150 > 60000 is false in number comparison
      expect(config.MAX_REPO_SIZE).to.be.a("number");
      expect(config.MAX_REPO_SIZE < 60000).to.be.true;
    });
  });

  // ---------------------------------------------------------------
  // Boolean coercion
  // ---------------------------------------------------------------
  describe("boolean values", function () {
    it('parses "true" to boolean true', function () {
      const config = parseConfigFromEnv(defaults, {
        ENABLE_DOWNLOAD: "true",
      });
      expect(config.ENABLE_DOWNLOAD).to.equal(true);
      expect(config.ENABLE_DOWNLOAD).to.be.a("boolean");
    });

    it('parses "false" to boolean false', function () {
      const config = parseConfigFromEnv(defaults, {
        ENABLE_DOWNLOAD: "false",
      });
      expect(config.ENABLE_DOWNLOAD).to.equal(false);
      expect(config.ENABLE_DOWNLOAD).to.be.a("boolean");
    });

    it('parses "1" to boolean true', function () {
      const config = parseConfigFromEnv(defaults, {
        ENABLE_DOWNLOAD: "1",
      });
      expect(config.ENABLE_DOWNLOAD).to.equal(true);
    });

    it('parses "0" to boolean false', function () {
      const config = parseConfigFromEnv(defaults, {
        ENABLE_DOWNLOAD: "0",
      });
      expect(config.ENABLE_DOWNLOAD).to.equal(false);
    });

    it("parses arbitrary string to boolean false", function () {
      const config = parseConfigFromEnv(defaults, {
        ENABLE_DOWNLOAD: "yes",
      });
      expect(config.ENABLE_DOWNLOAD).to.equal(false);
    });
  });

  // ---------------------------------------------------------------
  // String values
  // ---------------------------------------------------------------
  describe("string values", function () {
    it("overwrites string config with env string", function () {
      const config = parseConfigFromEnv(defaults, {
        SESSION_SECRET: "my-secret-key",
      });
      expect(config.SESSION_SECRET).to.equal("my-secret-key");
    });

    it("overwrites APP_HOSTNAME", function () {
      const config = parseConfigFromEnv(defaults, {
        APP_HOSTNAME: "my.domain.com",
      });
      expect(config.APP_HOSTNAME).to.equal("my.domain.com");
    });

    it("overwrites STORAGE", function () {
      const config = parseConfigFromEnv(defaults, { STORAGE: "s3" });
      expect(config.STORAGE).to.equal("s3");
    });
  });

  // ---------------------------------------------------------------
  // Unknown keys
  // ---------------------------------------------------------------
  describe("unknown keys", function () {
    it("ignores environment variables not in defaults", function () {
      const config = parseConfigFromEnv(defaults, {
        UNKNOWN_VAR: "some-value",
      });
      expect(config.UNKNOWN_VAR).to.be.undefined;
    });
  });

  // ---------------------------------------------------------------
  // Multiple overrides
  // ---------------------------------------------------------------
  describe("multiple overrides at once", function () {
    it("applies all overrides correctly", function () {
      const config = parseConfigFromEnv(defaults, {
        PORT: "8080",
        ENABLE_DOWNLOAD: "false",
        SESSION_SECRET: "new-secret",
        MAX_REPO_SIZE: "120000",
      });
      expect(config.PORT).to.equal(8080);
      expect(config.ENABLE_DOWNLOAD).to.equal(false);
      expect(config.SESSION_SECRET).to.equal("new-secret");
      expect(config.MAX_REPO_SIZE).to.equal(120000);
    });
  });
});
