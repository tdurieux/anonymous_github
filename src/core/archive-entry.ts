import { Archiver, EntryData } from "archiver";
import { Readable } from "stream";
/** Allow only one active entry; compression and the response provide backpressure. */
export function appendArchiveEntry(archive: Archiver, source: Readable, options: EntryData): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      archive.removeListener("entry", done); archive.removeListener("error", fail);
      archive.removeListener("close", closed); source.removeListener("error", fail);
    };
    const done = () => { cleanup(); resolve(); };
    const fail = (error: Error) => { cleanup(); source.destroy(); reject(error); };
    const closed = () => fail(new Error("archive_cancelled"));
    archive.once("entry", done); archive.once("error", fail); archive.once("close", closed);
    source.once("error", fail);
    archive.append(source, options);
  });
}
