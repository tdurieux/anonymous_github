const { expect } = require("chai");
require("ts-node/register/transpile-only");

const mongoose = require("mongoose");
const {
  isOwnerOrAdmin,
  isCoauthor,
  isOwnerCoauthorOrAdmin,
} = require("../src/server/routes/route-utils");
const AnonymousError = require("../src/core/AnonymousError").default;
const User = require("../src/core/User").default;
const UserModel = require("../src/core/model/users/users.model").default;
const Repository = require("../src/core/Repository").default;

/**
 * Tests for the authorization helpers in src/server/routes/route-utils.ts.
 * These functions are pure (read-only on the User/Repository instances)
 * so they can be exercised directly with hand-built mongoose-backed
 * model objects without a live DB.
 */

function makeUser({ id, username, isAdmin = false } = {}) {
  const _id = id || new mongoose.Types.ObjectId();
  return new User(
    new UserModel({
      _id,
      id: _id.toString(),
      username,
      isAdmin,
      accessTokens: { github: "tok" },
    })
  );
}

function makeRepo({ ownerId, coauthors = [] } = {}) {
  return new Repository({
    owner: ownerId || new mongoose.Types.ObjectId(),
    repoId: "r1",
    source: {},
    options: {},
    coauthors,
  });
}

describe("route-utils.isOwnerOrAdmin", function () {
  it("returns silently when user id is in the authorized list", function () {
    const user = makeUser({ username: "alice" });
    expect(() =>
      isOwnerOrAdmin([user.model.id, "other"], user)
    ).to.not.throw();
  });

  it("returns silently when user is admin even if not listed", function () {
    const user = makeUser({ username: "alice", isAdmin: true });
    expect(() => isOwnerOrAdmin(["someone-else"], user)).to.not.throw();
  });

  it("throws not_authorized AnonymousError with httpStatus 401 otherwise", function () {
    const user = makeUser({ username: "alice" });
    let caught;
    try {
      isOwnerOrAdmin(["someone-else"], user);
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(AnonymousError);
    expect(caught.message).to.equal("not_authorized");
    expect(caught.httpStatus).to.equal(401);
  });

  it("treats an empty authorized list as unauthorized for non-admin", function () {
    const user = makeUser({ username: "alice" });
    expect(() => isOwnerOrAdmin([], user)).to.throw(AnonymousError);
  });
});

describe("route-utils.isCoauthor", function () {
  it("returns true when the user's username matches a coauthor entry", function () {
    const user = makeUser({ username: "alice" });
    const repo = makeRepo({ coauthors: [{ username: "alice" }] });
    expect(isCoauthor(repo, user)).to.equal(true);
  });

  it("returns false when no coauthor matches the username", function () {
    const user = makeUser({ username: "alice" });
    const repo = makeRepo({ coauthors: [{ username: "bob" }] });
    expect(isCoauthor(repo, user)).to.equal(false);
  });

  it("returns false when coauthors is undefined", function () {
    const user = makeUser({ username: "alice" });
    const repo = makeRepo({ coauthors: undefined });
    expect(isCoauthor(repo, user)).to.equal(false);
  });

  it("returns false when coauthors is an empty list", function () {
    const user = makeUser({ username: "alice" });
    const repo = makeRepo({ coauthors: [] });
    expect(isCoauthor(repo, user)).to.equal(false);
  });

  it("returns false when the user has no username (early return)", function () {
    const user = makeUser({ username: undefined });
    const repo = makeRepo({ coauthors: [{ username: "alice" }] });
    expect(isCoauthor(repo, user)).to.equal(false);
  });

  it("matches case-sensitively (alice !== Alice)", function () {
    const user = makeUser({ username: "alice" });
    const repo = makeRepo({ coauthors: [{ username: "Alice" }] });
    expect(isCoauthor(repo, user)).to.equal(false);
  });
});

describe("route-utils.isOwnerCoauthorOrAdmin", function () {
  it("admin short-circuits regardless of ownership", function () {
    const user = makeUser({ username: "carol", isAdmin: true });
    const repo = makeRepo();
    expect(() => isOwnerCoauthorOrAdmin(repo, user)).to.not.throw();
  });

  it("owner is allowed when user.id matches repo.owner.id", function () {
    const id = new mongoose.Types.ObjectId();
    const user = makeUser({ id, username: "alice" });
    const repo = makeRepo({ ownerId: id });
    expect(repo.owner.model.id).to.equal(user.model.id);
    expect(() => isOwnerCoauthorOrAdmin(repo, user)).to.not.throw();
  });

  it("coauthor is allowed", function () {
    const user = makeUser({ username: "alice" });
    const repo = makeRepo({ coauthors: [{ username: "alice" }] });
    expect(() => isOwnerCoauthorOrAdmin(repo, user)).to.not.throw();
  });

  it("throws not_authorized with httpStatus 403 for an unrelated user", function () {
    const user = makeUser({ username: "stranger" });
    const repo = makeRepo({ coauthors: [{ username: "alice" }] });
    let caught;
    try {
      isOwnerCoauthorOrAdmin(repo, user);
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(AnonymousError);
    expect(caught.message).to.equal("not_authorized");
    expect(caught.httpStatus).to.equal(403);
  });
});
