import mongoose from "mongoose";
import { measureStage } from "./request-monitoring";

let installed = false;
/** Measure Mongoose query/aggregate execution, including pool/buffering wait.
 * No query text, model names, results or parameters enter the logging context.
 * Direct driver operations, document saves and bulk writes are not covered.
 */
export function installDatabaseTiming() {
  if (installed) return;
  installed = true;
  for (const prototype of [mongoose.Query.prototype, mongoose.Aggregate.prototype]) {
    const original = prototype.exec;
    prototype.exec = function (this: unknown, ...args: unknown[]) {
      return measureStage("database", () => Reflect.apply(original, this, args));
    } as typeof original;
  }
}
