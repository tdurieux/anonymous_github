import archiver = require("archiver");
import { once } from "events";
import { createReadStream, closeSync, mkdtempSync, openSync, rmSync, writeSync, utimesSync, ReadStream } from "fs";
import { setInterval, clearInterval } from "timers";
import { tmpdir } from "os";
import { join } from "path";

// archiver 7 / zip-stream 6 / compress-commons 6 retain all directory entries
// and synchronously emit millions of buffers at finalize(). Keep their ZIP
// encoding (including ZIP64), but spool directory records as entries finish.
interface ZipEngine extends NodeJS.WritableStream {
  offset: number;
  _entries: { length: number; push(entry: unknown): number };
  _archive: { centralOffset: number; centralLength: number; processing: boolean; finish: boolean; finished: boolean };
  _finish(): void;
  _writeCentralFileHeader(entry: unknown): void;
  _writeCentralDirectoryZip64(): void;
  _writeCentralDirectoryEnd(): void;
  isZip64(): boolean;
  emit(event: string, error: Error): boolean;
}

export function boundedZip() {
  const archive = archiver("zip", {});
  const engine = (archive as unknown as { _module: { engine: ZipEngine } })._module.engine;
  if (!Array.isArray(engine._entries) || typeof engine._writeCentralFileHeader !== "function" ||
      typeof engine._writeCentralDirectoryZip64 !== "function" || typeof engine._writeCentralDirectoryEnd !== "function") {
    throw new Error("unsupported_zip_engine");
  }
  const cancellation = new AbortController();
  let directory: string | undefined;
  let fd: number | undefined;
  let reader: ReadStream | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let count = 0;
  let finalizing = false;
  const cleanup = () => {
    clearInterval(heartbeat); heartbeat = undefined;
    reader?.destroy();
    reader = undefined;
    if (fd !== undefined) { closeSync(fd); fd = undefined; }
    if (directory) { rmSync(directory, { recursive: true, force: true }); directory = undefined; }
  };
  const stop = () => { cancellation.abort(); cleanup(); };
  const abort = archive.abort;
  archive.abort = function () { stop(); return abort.call(this); };
  archive.once("error", stop);
  archive.once("close", stop);
  archive.once("end", cleanup);

  engine._entries = {
    get length() { return count; },
    push(entry) {
      try {
        if (cancellation.signal.aborted) return count;
        if (fd === undefined) {
          directory = mkdtempSync(join(tmpdir(), "anonymous-zip-directory-"));
          fd = openSync(join(directory, "central"), "wx", 0o600);
          // A paused download can outlive the stale-spool cleanup threshold.
          heartbeat = setInterval(() => {
            if (directory) {
              const now = new Date();
              try { utimesSync(join(directory, "central"), now, now); } catch { /* writes/reads report I/O errors */ }
            }
          }, 60_000);
          heartbeat.unref();
        }
        // A directory record is bounded by ZIP's 16-bit name/extra/comment
        // lengths. Serialize only this record, without touching output offsets.
        const chunks: Buffer[] = [];
        const write = engine.write;
        const offset = engine.offset;
        try {
          engine.write = (chunk: Uint8Array | string) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; };
          engine._writeCentralFileHeader(entry);
        } finally { engine.write = write; engine.offset = offset; }
        const record = Buffer.concat(chunks);
        let written = 0;
        while (written < record.length) written += writeSync(fd, record, written, record.length - written);
        return ++count;
      } catch (error) { engine.emit("error", error as Error); return count; }
    },
  };
  engine._finish = () => {
    if (finalizing || cancellation.signal.aborted) return;
    finalizing = true;
    engine._archive.finish = true;
    engine._archive.centralOffset = engine.offset;
    void (async () => {
      if (fd !== undefined) { closeSync(fd); fd = undefined; }
      if (directory) {
        reader = createReadStream(join(directory, "central"), { highWaterMark: 64 * 1024 });
        for await (const chunk of reader) {
          cancellation.signal.throwIfAborted();
          if (!engine.write(chunk)) await once(engine, "drain", { signal: cancellation.signal });
        }
      }
      cancellation.signal.throwIfAborted();
      engine._archive.centralLength = engine.offset - engine._archive.centralOffset;
      if (engine.isZip64()) engine._writeCentralDirectoryZip64();
      engine._writeCentralDirectoryEnd();
      engine._archive.processing = false;
      engine._archive.finished = true;
      engine.end();
      cleanup();
    })().catch(error => { if (!cancellation.signal.aborted) engine.emit("error", error); cleanup(); });
  };
  return archive;
}
