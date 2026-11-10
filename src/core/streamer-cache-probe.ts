import got, { Response } from "got";

/** Wait only for headers; the body remains a backpressured stream. */
export async function probeStreamerCache(url: string, json: Record<string, unknown>, headers: Record<string, string>, signal?: AbortSignal) {
  const stream = got.stream(url, { method: "POST", json: { ...json, token: "", cacheOnly: true },
    headers, timeout: { response: 15000 }, decompress: false });
  const responseReady = new Promise<Response>((resolve, reject) => {
    stream.once("response", resolve);
    stream.once("error", reject);
  });
  const abort = () => stream.destroy(new Error("response_cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  stream.once("close", () => signal?.removeEventListener("abort", abort));
  if (signal?.aborted) abort();
  try {
    const response = await responseReady;
    return { stream, response };
  } catch (error) {
    stream.destroy();
    const response = (error as { response?: Response }).response;
    if (response?.statusCode === 409 && response.headers["x-anonymous-cache-miss"] === "1") return undefined;
    throw error;
  }
}
