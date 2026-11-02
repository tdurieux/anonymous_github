import { Archiver, EntryData, ZipEntryData } from "archiver";
import { extname } from "path";
import { Readable } from "stream";

const compressedExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".heif", ".heic",
  ".mp4", ".m4v", ".mov", ".webm", ".mp3", ".m4a", ".aac", ".ogg", ".flac",
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".zst", ".woff", ".woff2",
]);

/** Store already compressed assets; every entry still passes through anonymization. */
export function zipEntryOptions(name: string, originalName = name): ZipEntryData {
  return { name, store: compressedExtensions.has(extname(originalName).toLowerCase()) };
}
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
