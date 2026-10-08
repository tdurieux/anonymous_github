import config from "../config";
import { parentPort } from "worker_threads";
import { readFileSync, writeFileSync } from "fs";
import { ContentAnonimizer } from "./anonymize-utils";

parentPort!.on("message", ({ input, output, options, maxOutput, context }) => {
  try {
    config.ANONYMIZATION_MASK = context.mask;
    config.APP_HOSTNAME = context.hostname;
    const original = readFileSync(input);
    const text = original.toString("utf8");
    const anonymizer = new ContentAnonimizer(options);
    // Large RE2 jobs legitimately take more than the synchronous one-second
    // limit. The pool also terminates this worker after 15 seconds, including
    // input/output and compilation. Native backtracking patterns retain their
    // own one-second deadline inside ContentAnonimizer.
    const transformed = anonymizer.anonymize(text, 10_000);
    if (Buffer.byteLength(transformed, "utf8") > maxOutput) throw new Error("anonymized_output_too_large");
    const bytes = transformed === text ? original : Buffer.from(transformed, "utf8");
    if (bytes.length > maxOutput) throw new Error("anonymized_output_too_large");
    writeFileSync(output, bytes, { flag: "wx" });
    parentPort!.postMessage({ changed: anonymizer.wasAnonymized });
  } catch (error) {
    parentPort!.postMessage({ error: (error as Error).message });
  }
});
