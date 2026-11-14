const { expect } = require("chai");
const { Queue, QueueEvents, Worker } = require("bullmq");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const port = Number(process.env.PERFORMANCE_REDIS_PORT);

(port ? describe : describe.skip)("sandboxed quota retry policy", function () {
  this.timeout(30000);
  let queue, events, worker;
  before(async () => {
    const name = `quota-test-${randomUUID()}`;
    const connection = { host: "127.0.0.1", port };
    queue = new Queue(name, { connection });
    events = new QueueEvents(name, { connection });
    await events.waitUntilReady();
    worker = new Worker(name, path.resolve(__dirname, "fixtures/quota-download.worker.cjs"), { connection });
    await worker.waitUntilReady();
  });
  after(async () => {
    await worker?.close();
    if (queue) await queue.obliterate({ force: true });
    await events?.close(); await queue?.close();
  });
  for (const [failure, attempts] of [["quota_exceeded", 1], ["github_unavailable", 3]]) {
    it(`${failure} executes ${attempts} time(s) across the sandbox boundary`, async () => {
      let executions = 0;
      const active = () => { executions++; };
      worker.on("active", active);
      try {
        const job = await queue.add("download", { repoId: failure, failure }, { attempts: 3 });
        const error = await job.waitUntilFinished(events, 20000).catch(error => error);
        expect(error).to.be.instanceOf(Error); expect(error.message).to.equal(failure);
        const failed = await queue.getJob(job.id);
        expect(await failed.getState()).to.equal("failed");
        expect(failed.attemptsMade).to.equal(attempts);
        expect(executions).to.equal(attempts);
      } finally { worker.off("active", active); }
    });
  }
});
