const { expect } = require("chai");

describe("admin queue jobs", function () {
  it("returns job payloads, failure reasons and stacks as values, not JSON strings", async function () {
    const queues = require("../src/queue");
    const metrics = require("../src/queue/queueMetrics");
    const router = require("../src/server/routes/admin").default;
    const handler = router.stack.find(layer => layer.route?.path === "/queues").route.stack.at(-1).handle;
    const originals = [queues.downloadQueue, queues.removeQueue, queues.cacheQueue, metrics.queryMetrics];
    const failed = {
      data: { repoId: "paper-7F2A" }, failedReason: "branch_not_found", stacktrace: ["Error: branch_not_found\n    at fetch"], returnvalue: null,
      // BullMQ's asJSON() stringifies these four fields.
      asJSON() { return { id: "paper-7F2A", name: "paper-7F2A", data: JSON.stringify(this.data), failedReason: JSON.stringify(this.failedReason), stacktrace: JSON.stringify(this.stacktrace), returnvalue: JSON.stringify(this.returnvalue) }; },
    };
    const queue = { getJobCounts: async () => ({}), getWorkers: async () => [], isPaused: async () => false,
      getJobs: async ([state]) => state === "failed" ? [failed] : [] };
    queues.downloadQueue = queue; queues.removeQueue = queue; queues.cacheQueue = queue;
    metrics.queryMetrics = async () => [];
    try {
      let body;
      // The remove queue keeps this snapshot apart from other tests' cache entries.
      await handler({ query: { queue: "remove" } }, { json: data => { body = data; } });
      const job = body.jobs.find(j => j.id === "paper-7F2A");
      expect(job.data).to.deep.equal({ repoId: "paper-7F2A" });
      expect(job.failedReason).to.equal("branch_not_found");
      expect(job.stacktrace).to.deep.equal(["Error: branch_not_found\n    at fetch"]);
      expect(job._state).to.equal("failed");
    } finally {
      [queues.downloadQueue, queues.removeQueue, queues.cacheQueue, metrics.queryMetrics] = originals;
    }
  });
});
