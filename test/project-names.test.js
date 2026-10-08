const { expect } = require("chai");
require("ts-node/register/transpile-only");
const User = require("../src/core/User").default;
const UserModel = require("../src/core/model/users/users.model").default;
const { projectNameKey, saveProjectName } = require("../src/server/routes/project-names");

describe("private project names", () => {
  let updateOne, writes, user;
  beforeEach(() => {
    updateOne = UserModel.updateOne;
    writes = [];
    UserModel.updateOne = async (query, update) => { writes.push({ query, update }); };
    user = new User(new UserModel({ username: "owner" }));
    user.getRepositories = async () => [{ repoId: "artifact.v2" }];
    user.getPullRequests = async () => [{ pullRequestId: "artifact.v2" }];
    user.getGists = async () => [{ gistId: "artifact.v2" }];
  });
  afterEach(() => { UserModel.updateOne = updateOne; });

  for (const type of ["repo", "pr", "gist"]) {
    it(`saves a ${type} name only on the current user's record`, async () => {
      const name = await saveProjectName(user, { type, id: "artifact.v2", name: "  Reproduction package  " });
      expect(name).to.equal("Reproduction package");
      expect(writes).to.have.length(1);
      expect(String(writes[0].query._id)).to.equal(String(user.model._id));
      expect(writes[0].update).to.deep.equal({ $set: { ["projectNames." + projectNameKey(type, "artifact.v2")]: name } });
      expect(user.model.projectNames.get(projectNameKey(type, "artifact.v2"))).to.equal(name);
    });
  }
  it("keeps names for different artifact types distinct", () => {
    expect(projectNameKey("repo", "same.id")).not.to.equal(projectNameKey("pr", "same.id"));
    expect(projectNameKey("repo", "same.id")).to.match(/^[a-f0-9]{64}$/);
  });
  it("removes a saved name when the field is cleared", async () => {
    await saveProjectName(user, { type: "repo", id: "artifact.v2", name: "Package" });
    await saveProjectName(user, { type: "repo", id: "artifact.v2", name: " " });
    expect(writes[1].update).to.deep.equal({ $unset: { ["projectNames." + projectNameKey("repo", "artifact.v2")]: "" } });
    expect(user.model.projectNames.has(projectNameKey("repo", "artifact.v2"))).to.equal(false);
  });
  it("rejects naming a project outside the user's accessible records", async () => {
    let error;
    try { await saveProjectName(user, { type: "repo", id: "someone-elses-project", name: "Mine" }); }
    catch (caught) { error = caught; }
    expect(error.httpStatus).to.equal(403);
    expect(writes).to.have.length(0);
  });
  it("rejects invalid names and object-shaped identifiers before writing", async () => {
    for (const input of [null, { type: ["repo"], id: "artifact.v2", name: "Bad" },
      { type: "repo", id: { $ne: null }, name: "Bad" }, { type: "repo", id: "artifact.v2", name: "x".repeat(101) },
      { type: "repo", id: "artifact.v2", name: "Two\nlines" },
      ...[0, 31, 127].map(code => ({ type: "repo", id: "artifact.v2", name: "Name" + String.fromCharCode(code) }))]) {
      let error;
      try { await saveProjectName(user, input); } catch (caught) { error = caught; }
      expect(error.httpStatus).to.equal(400);
    }
    expect(writes).to.have.length(0);
  });
  it("does not change the in-memory name when persistence fails", async () => {
    UserModel.updateOne = async () => { throw Error("Database unavailable"); };
    let error;
    try { await saveProjectName(user, { type: "repo", id: "artifact.v2", name: "Package" }); }
    catch (caught) { error = caught; }
    expect(error.message).to.equal("Database unavailable");
    expect(user.model.projectNames).to.equal(undefined);
  });
});
