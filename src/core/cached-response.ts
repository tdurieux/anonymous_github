import { createGzip } from "zlib";
import { createHash } from "crypto";
import { Readable, PassThrough } from "stream";
import { pipeline } from "stream/promises";
import { Response } from "express";
import { performance } from "perf_hooks";
import config from "../config";
import { assertTransformScopeActive } from "./transformed-cache";
import { BlobStream, CacheAdmissionError, resultBlobCache } from "./blob-cache";
import { AnonymizeTransformer, classifyByName } from "./anonymize-utils";
import { observeCache } from "./cache-observability";

class Unchanged extends Error {}
export function decisionKey(digest: string, options: unknown) {
  return createHash("sha256").update(JSON.stringify(["anonymizer-v2", digest, options,
    config.ANONYMIZATION_MASK, config.APP_HOSTNAME, config.additionalExtensions])).digest("hex");
}
/** Returns false when the caller should use the existing streaming pipeline. Authorization precedes this call. */
export async function sendSharedContent(content: Readable, res: Response,
  options: ConstructorParameters<typeof AnonymizeTransformer>[0]): Promise<boolean> {
  try { return await sendCached(content, res, options); }
  catch (error) { if (error instanceof CacheAdmissionError) return false; content.destroy(); throw error; }
}
async function sendCached(content: Readable, res: Response,
  options: ConstructorParameters<typeof AnonymizeTransformer>[0]): Promise<boolean> {
  const source = (content as BlobStream).cachedBlob;
  const results = resultBlobCache();
  if (!source || !results) return false;
  const assertActive = async () => {
    if (res.destroyed) throw new Error("response_cancelled");
    await assertTransformScopeActive(options);
    if (res.destroyed) throw new Error("response_cancelled");
  };
  const encoding = res.req.acceptsEncodings("gzip", "identity");
  res.vary("Accept-Encoding");
  if (!encoding) { content.destroy(); res.status(406).end(); return true; }
  const key = decisionKey(source.record.digest, options);
  const namedType = classifyByName(options.filePath);
  const send = async (store: typeof results, digest: string, isText: boolean, onHit?: () => void) => {
    const stream = await store.open(digest, encoding === "gzip");
    if (!stream) return false;
    try { await assertActive(); } catch (error) { stream.destroy(); throw error; }
    const record = stream.cachedBlob!.record;
    onHit?.();
    content.destroy();
    if (record.encoding === "gzip" && encoding === "gzip") {
      res.setHeader("Content-Encoding", "gzip"); res.setHeader("Content-Length", record.stored);
    } else { res.removeHeader("Content-Encoding"); res.setHeader("Content-Length", record.size); }
    if (isText && !res.getHeader("Content-Type")) res.type("text/plain");
    if (isText) res.setHeader("Accept-Ranges", "none");
    else res.removeHeader("Accept-Ranges");
    if (record.encoding === "identity" && !res.req.acceptsEncodings("identity")) {
      res.setHeader("Content-Encoding", "gzip"); res.removeHeader("Content-Length");
      await pipeline(stream, createGzip(), res);
    } else await pipeline(stream, res);
    return true;
  };
  const decision = results.decision(key);
  if (decision && (decision.isText !== undefined || namedType !== null) && await send(decision.changed ? results : source.store, decision.digest, decision.isText ?? namedType!, () => {
    observeCache("decision_hit", source.record.size);
    observeCache(decision.changed ? "rewrite_changed_cached" : "rewrite_unchanged_cached", source.record.size);
  })) return true;
  observeCache("decision_miss", source.record.size);
  if (classifyByName(options.filePath) === false) {
    results.saveDecision(key, source.record.digest, false, false);
    observeCache("rewrite_binary", source.record.size);
    return send(source.store, source.record.digest, false);
  }
  // Preserve the original source reader as a fallback if result admission fails.
  let processing: Readable | undefined;
  let transformer: AnonymizeTransformer | undefined;
  const started = performance.now();
  const abort = () => {
    if (!res.writableFinished) {
      const error = new Error("response_cancelled");
      transformer?.destroy(error);
      processing?.destroy(error);
    }
  };
  res.once("close", abort);
  try {
    const output = await results.getOrFill(`render-${key}`, async () => {
      await assertActive();
      processing = await source.store.open(source.record.digest);
      if (!processing) throw new CacheAdmissionError("source_evicted");
      if (res.destroyed) throw new Error("response_cancelled");
      const transform = transformer = new AnonymizeTransformer({ ...options, decisionManaged: true });
      const stream = new PassThrough();
      void pipeline(processing, transform, stream).catch(error => stream.destroy(error));
      return stream;
    }, async proof => {
      await assertActive();
      const unchanged = source.record.digest === `git-${proof.gitSha}` || source.record.digest === `sha256-${proof.sha256}`;
      observeCache(unchanged ? "rewrite_unchanged" : "rewrite_changed", source.record.size, performance.now() - started);
      if (unchanged) { results.saveDecision(key, source.record.digest, false, !!transformer?.isText); throw new Unchanged(); }
      return `sha256-${proof.sha256}`;
    }, source.record.size);
    const digest = output.cachedBlob!.record.digest;
    // Keep the result pinned until its HTTP reader has been opened.
    try {
      await assertActive();
      results.saveDecision(key, digest, true, true);
      if (await send(results, digest, true)) return true;
    } finally { output.destroy(); }
    return false;
  } catch (error) {
    if (error instanceof Unchanged) return send(source.store, source.record.digest, !!transformer?.isText);
    if (error instanceof CacheAdmissionError) { observeCache("decision_bypass", source.record.size); return false; }
    content.destroy(); throw error;
  } finally { res.removeListener("close", abort); transformer?.destroy(); processing?.destroy(); }
}
