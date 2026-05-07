const { expect } = require("chai");
require("ts-node/register/transpile-only");

const { handleError } = require("../src/server/routes/route-utils");
const AnonymousError = require("../src/core/AnonymousError").default;

/**
 * Direct tests against the real handleError implementation. Each test
 * builds a fake express response and asserts the status code + JSON
 * body that handleError produced.
 */

function makeRes() {
  const res = {
    statusCode: undefined,
    body: undefined,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return res;
}

// Silence the console.error noise that printError emits during tests.
let originalErr;
before(function () {
  originalErr = console.error;
  console.error = () => {};
});
after(function () {
  console.error = originalErr;
});

describe("route-utils.handleError", function () {
  it("uses error.httpStatus when present", function () {
    const res = makeRes();
    const err = new AnonymousError("boom", { httpStatus: 418 });
    handleError(err, res);
    expect(res.statusCode).to.equal(418);
    expect(res.body).to.deep.equal({ error: "boom" });
  });

  it("falls back to error.$metadata.httpStatusCode (S3-style errors)", function () {
    const res = makeRes();
    const err = Object.assign(new Error("S3 down"), {
      $metadata: { httpStatusCode: 503 },
    });
    handleError(err, res);
    expect(res.statusCode).to.equal(503);
    expect(res.body).to.deep.equal({ error: "internal_error" });
  });

  it("maps messages containing 'not_found' to 404", function () {
    const res = makeRes();
    handleError(new Error("repo_not_found"), res);
    expect(res.statusCode).to.equal(404);
    expect(res.body).to.deep.equal({ error: "internal_error" });
  });

  it("maps messages containing '(Not Found)' (got HTTPError style) to 404", function () {
    const res = makeRes();
    handleError(new Error("Response code 404 (Not Found)"), res);
    expect(res.statusCode).to.equal(404);
  });

  it("maps messages containing 'not_connected' to 401", function () {
    const res = makeRes();
    handleError(new Error("user_not_connected"), res);
    expect(res.statusCode).to.equal(401);
    expect(res.body).to.deep.equal({ error: "internal_error" });
  });

  it("defaults to 500 when nothing matches", function () {
    const res = makeRes();
    handleError(new Error("kaboom"), res);
    expect(res.statusCode).to.equal(500);
    expect(res.body).to.deep.equal({ error: "internal_error" });
  });

  it("accepts a string error and stringifies it in the body", function () {
    const res = makeRes();
    handleError("something_bad", res);
    expect(res.statusCode).to.equal(500);
    expect(res.body).to.deep.equal({ error: "internal_error" });
  });

  it("does not call res when headersSent is true", function () {
    const res = makeRes();
    res.headersSent = true;
    handleError(new Error("late"), res);
    expect(res.statusCode).to.equal(undefined);
    expect(res.body).to.equal(undefined);
  });

  it("is a no-op-on-res when no res is passed", function () {
    expect(() => handleError(new Error("noop"))).to.not.throw();
  });
});
