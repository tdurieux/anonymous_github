import { Worker } from "worker_threads";
import { existsSync } from "fs";
import { join } from "path";
import { startStage } from "./request-monitoring";
import { AsyncResource } from "async_hooks";

const MEMORY_BUDGET = Math.max(128, Number(process.env.ANONYMIZATION_MEMORY_MB) || 512) * 1024 * 1024;
const MAX_WORKERS = Math.min(4, Math.max(1, Number(process.env.ANONYMIZATION_WORKERS) || 1));
interface Job {
  message: { input: string; output: string; options: unknown; maxOutput: number; context: { mask: string; hostname: string } };
  weight: number;
  signal: AbortSignal;
  resolve: (changed: boolean) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  abort?: () => void;
  waitingDone: ReturnType<typeof startStage>;
  transformDone: () => ReturnType<typeof startStage>;
}
const waiting: Job[] = [];
const idle: Worker[] = [];
let running = 0;
let bytes = 0;

export function anonymizeOnWorker(message: Job["message"], size: number, signal: AbortSignal): Promise<boolean> {
  const weight = 64 * 1024 * 1024 + size * 4;
  if (weight > MEMORY_BUDGET) return Promise.reject(new Error("anonymization_memory_budget_exceeded"));
  if (waiting.length >= 16) return Promise.reject(new Error("anonymization_queue_full"));
  return new Promise((resolve, reject) => {
    const waitingDone = startStage("worker_wait");
    // Bind the stage factory to the submitting request, not the preceding job.
    const transformDone = AsyncResource.bind(() => startStage("anonymize"));
    const job: Job = { message, weight, signal, resolve, reject, waitingDone, transformDone };
    job.abort = () => {
      const index = waiting.indexOf(job);
      if (index < 0) return;
      waiting.splice(index, 1);
      clearTimeout(job.timer);
      signal.removeEventListener("abort", job.abort!);
      waitingDone(true);
      reject(new Error("anonymization_cancelled"));
    };
    if (signal.aborted) { waitingDone(true); return reject(new Error("anonymization_cancelled")); }
    signal.addEventListener("abort", job.abort, { once: true });
    job.timer = setTimeout(job.abort, 30_000);
    waiting.push(job);
    pump();
  });
}
function pump() {
  while (waiting.length && running < MAX_WORKERS && bytes + waiting[0].weight <= MEMORY_BUDGET) {
    const job = waiting.shift()!;
    job.waitingDone();
    const transformDone = job.transformDone();
    clearTimeout(job.timer);
    job.signal.removeEventListener("abort", job.abort!);
    running++;
    bytes += job.weight;
    const compiled = join(__dirname, "anonymization.worker.js");
    let worker: Worker;
    try { worker = idle.pop() || new Worker(existsSync(compiled) ? compiled : join(__dirname, "anonymization.worker.ts"), {
      execArgv: existsSync(compiled) ? [] : ["-r", require.resolve("ts-node/register/transpile-only")],
      resourceLimits: { maxOldGenerationSizeMb: Math.ceil(MEMORY_BUDGET / 1024 / 1024) },
    }); } catch (error) { running--; bytes -= job.weight; transformDone(true); job.reject(error as Error); continue; }
    worker.ref();
    let finished = false;
    const finish = (error?: Error, changed = false) => {
      if (finished) return;
      finished = true;
      transformDone(!!error);
      clearTimeout(deadline);
      job.signal.removeEventListener("abort", cancel);
      worker.removeListener("message", message);
      worker.removeListener("error", failed);
      worker.removeListener("exit", exited);
      const release = () => { running--; bytes -= job.weight; pump(); };
      // Large jobs can leave substantial unreachable buffers in V8 until GC.
      // Release their workers before admitting the next job.
      if (error || job.weight >= 96 * 1024 * 1024) {
        void worker.terminate().then(release, release);
      } else { idle.push(worker); worker.unref(); release(); }
      if (error) job.reject(error); else job.resolve(changed);
    };
    const message = (result: { error?: string; changed?: boolean }) => finish(result.error ? new Error(result.error) : undefined, result.changed);
    const failed = (error: Error) => finish(error);
    const exited = () => finish(new Error("anonymization_worker_exited"));
    const cancel = () => finish(new Error("anonymization_cancelled"));
    const deadline = setTimeout(() => finish(new Error("anonymization_deadline_exceeded")), 15_000);
    worker.once("message", message);
    worker.once("error", failed);
    worker.once("exit", exited);
    job.signal.addEventListener("abort", cancel, { once: true });
    if (job.signal.aborted) cancel(); else worker.postMessage(job.message);
  }
}

let spoolBytes = 0;
export function reserveSpool(bytes: number) {
  if (spoolBytes + bytes > MEMORY_BUDGET * 2) throw new Error("anonymization_spool_budget_exceeded");
  spoolBytes += bytes;
}
export function releaseSpool(bytes: number) { spoolBytes -= bytes; }
export function getAnonymizationPoolStats() {
  return { running, waiting: waiting.length, idle: idle.length, reservedBytes: bytes, spoolBytes,
    maxWorkers: MAX_WORKERS, maxWaiting: 16, memoryBudgetBytes: MEMORY_BUDGET };
}
