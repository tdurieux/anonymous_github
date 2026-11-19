const { expect } = require("chai");
require("ts-node/register/transpile-only");
const { anonymizationErrorCode } = require("../src/core/anonymization-errors");
const { memoryBreakdown } = require("../src/core/log-memory");
const { logRecord } = require("../src/core/log-record");
describe("bounded anonymization failure evidence", () => {
  it("retains recognized failure causes and never forwards source text or paths", () => {
    for (const [error, expected] of [
      [new Error("anonymized_output_too_large"), "anonymized_output_too_large"],
      [Object.assign(new Error("private file"), {code:"ENOSPC"}), "anonymization_storage_full"],
      [Object.assign(new Error("private pattern"), {code:"ERR_SCRIPT_EXECUTION_TIMEOUT"}), "anonymization_deadline_exceeded"],
      [new Error("/private/source/token"), "anonymization_worker_failed"],
      [Object.defineProperty({}, "message", {get(){throw new Error("getter invoked");}}), "anonymization_worker_failed"],
    ]) {
      const code = anonymizationErrorCode(error);
      expect(code).to.equal(expected);
      expect(logRecord("error", "zip-stream", [new Error(code)]).errorCode).to.equal(code);
    }
  });
  it("retains a queue timeout and unsafe ZIP code separately from cancellation", () => {
    for (const code of ["anonymization_queue_timeout", "anonymization_cancelled", "zip_unsafe_entry_path"]) {
      expect(logRecord("error", "zip-stream", [new Error(code)]).errorCode).to.equal(code);
    }
  });
  it("preserves a bounded cause through an actual worker without exposing a private filesystem path", async function () {
    this.timeout(15000);
    const { Worker } = require("worker_threads");
    const { once } = require("events");
    const worker = new Worker(require("path").resolve("src/core/anonymization.worker.ts"), {
      execArgv:["-r",require.resolve("ts-node/register/transpile-only")],
    });
    try {
      const received = once(worker, "message");
      worker.postMessage({input:"/nonexistent/private-repository/secret.txt",output:"/nonexistent/output",options:{terms:[]},maxOutput:100,context:{mask:"XXXX",hostname:"test.invalid"}});
      const [result] = await received;
      expect(result).to.deep.equal({error:"anonymization_io_failed"});
    } finally { await worker.terminate(); }
  });
  it("separates reclaimable cache from working set without hiding total pressure", () => {
    expect(memoryBreakdown(750, 768, "file 450\ninactive_file 400\n")).to.deep.equal({
      memoryFileCacheBytes:450,memoryWorkingSetBytes:350,memoryWorkingSetRatio:350/768,
    });
    expect(memoryBreakdown(750,768,"total_cache 450\ntotal_inactive_file 400")).to.deep.equal(memoryBreakdown(750,768,"file 450\ninactive_file 400"));
    expect(memoryBreakdown(750,768,"")).to.deep.equal({});
  });
});
