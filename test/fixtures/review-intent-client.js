require("ts-node/register/transpile-only");
const process = require("process");
const { setTimeout } = require("timers");
const { AbortController } = globalThis;
const {
  createReviewIntentConsumer,
} = require("../../src/server/service/review-intent-client");

process.on("message", async ({ id, config, input, mode }) => {
  try {
    const client = createReviewIntentConsumer(config);
    const controller = new AbortController();
    if (mode === "preabort") controller.abort();
    if (mode === "abort") setTimeout(() => controller.abort(), 100);
    if (mode === "mutate") {
      config.token = "invalid";
      config.origin = "https://invalid.example";
    }
    if (mode === "parallel") {
      const pending = Array.from({ length: 5 }, () =>
        client.consume(input, controller.signal),
      );
      const results = await Promise.allSettled(pending);
      const followup = await client.consume(input);
      process.send({
        id,
        results: results.map((r) =>
          r.status === "fulfilled" ? "ok" : r.reason.kind,
        ),
        followup,
      });
      return;
    }
    const started = Date.now();
    const result = await client.consume(input, controller.signal);
    process.send({
      id,
      result,
      elapsedMs: Date.now() - started,
      frozen: Object.isFrozen(result) && Object.isFrozen(result.policy),
      serialized: JSON.stringify(client),
    });
  } catch (error) {
    process.send({ id, kind: error.kind, message: error.message });
  }
});
