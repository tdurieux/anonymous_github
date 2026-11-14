/* global require, module */
require("ts-node/register/transpile-only");
const db = require("../../src/server/database");
const gh = require("../../src/core/GitHubUtils");
const notifications = require("../../src/core/owner-notifications");
const AnonymousError = require("../../src/core/AnonymousError").default;
const processDownload = require("../../src/queue/processes/downloadRepository").default;
db.connect = async () => {};
gh.getToken = async () => "test-token";
gh.getRedisGateResetAt = async () => 0;
notifications.notifyOwnerAccessProblem = async () => {};
module.exports = async job => {
  db.getRepository = async () => ({
    status: "preparing", owner: { id: "owner" }, model: {},
    async updateStatus(status) { this.status = status; },
    async resetSate() {},
    async anonymize() { throw new AnonymousError(job.data.failure, { httpStatus: job.data.failure === "quota_exceeded" ? 402 : 502 }); },
  });
  return processDownload(job);
};
