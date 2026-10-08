import { Readable, Writable } from "stream";

/** Cancel upstream on every response terminal event, including a pre-header close. */
export function streamResponse(source: Readable, response: Writable,
  onError: (error: Error) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.removeListener("close", done);
      response.removeListener("finish", done);
      response.removeListener("error", failed);
      source.removeListener("error", upstreamFailed);
      source.unpipe(response);
      source.destroy();
    };
    const done = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const upstreamFailed = (error: Error) => { onError(error); done(); };
    response.once("close", done);
    response.once("finish", done);
    response.once("error", failed);
    source.once("error", upstreamFailed);
    if (response.destroyed || response.writableEnded) done(); else source.pipe(response);
  });
}
