require("ts-node/register/transpile-only");
const { setTimeout } = require("node:timers");
const { Readable } = require("node:stream");
const { BlobCache } = require("../../src/core/blob-cache");
require("../../src/config").default.CACHE_MONITORING_ENABLED = false;
const cache = new BlobCache(JSON.parse(process.env.BLOB_TEST_OPTIONS));
if (process.env.BLOB_TEST_CRASH_AFTER_RENAME) {
  const fs = require("node:fs").promises, rename = fs.rename.bind(fs);
  fs.rename = async (...args) => {
    await rename(...args);
    process.send({ renamed: args[1] });
    await new Promise(() => {}); // Parent kills the process before index publication.
  };
}
if (process.env.BLOB_TEST_DISK_BYTES) require("node:fs").statfsSync = () => ({ bavail: Number(process.env.BLOB_TEST_DISK_BYTES), bsize: 1 });
process.send("ready");
process.once("message", async () => {
  try {
    const stream = await cache.getOrFill("multiprocess", async () => {
      process.send("fill");
      if (process.env.BLOB_TEST_HOLD_FILL) await new Promise(resolve => process.once("message", resolve));
      else await new Promise(resolve => setTimeout(resolve, 100));
      return Readable.from("shared across processes");
    });
    let body = ""; for await (const chunk of stream) body += chunk;
    cache.close(); process.send({ body }); process.disconnect();
  } catch (error) { process.send({ error: error.message }); process.exitCode = 1; process.disconnect(); }
});
