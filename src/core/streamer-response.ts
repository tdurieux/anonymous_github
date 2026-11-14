import { Readable } from "stream";
import AnonymousError from "./AnonymousError";

/** Internal streamer endpoints return content, never browser redirects. */
export function rejectStreamerRedirects<T extends Readable>(stream: T): T {
  stream.on("response", (response: { statusCode: number }) => {
    if (response.statusCode >= 300 && response.statusCode < 400) {
      stream.destroy(new AnonymousError("streamer_upstream_error", { httpStatus: 502 }));
    }
  });
  return stream;
}
