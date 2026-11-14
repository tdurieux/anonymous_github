import { PassThrough, Readable, Writable } from "stream";

/** Cancel upstream on every response terminal event, including a pre-header close. */
export function streamResponse(source: Readable, response: Writable,
  onError: (error: Error) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    // Got copies every upstream header/status when piped to ServerResponse.
    // A plain stream keeps response policy with the caller's explicit allowlist.
    const body = new PassThrough();
    const cleanup = () => {
      response.removeListener("close", done);
      response.removeListener("finish", done);
      response.removeListener("error", failed);
      source.removeListener("error", upstreamFailed);
      source.unpipe(body);
      body.unpipe(response);
      body.destroy();
      source.destroy();
    };
    const done = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const upstreamFailed = (error: Error) => { onError(error); done(); };
    response.once("close", done);
    response.once("finish", done);
    response.once("error", failed);
    source.once("error", upstreamFailed);
    if (response.destroyed || response.writableEnded) done();
    else if (source.errored) upstreamFailed(source.errored);
    else if (source.destroyed || source.readableEnded) upstreamFailed(new Error("upstream_stream_closed"));
    else { body.pipe(response); source.pipe(body); }
  });
}
