import { Request } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import { isCloudflareIP } from "./trustProxy";

export function requestRateLimitKey(request: Request): string {
  // Express resolves request.ip using the configured trusted proxies.
  let ip = request.ip || request.socket.remoteAddress || "";
  // Only accept Cloudflare's visitor header when resolution reached its edge.
  if (isCloudflareIP(ip)) {
    const visitor = request.headers["cf-connecting-ip"];
    if (typeof visitor === "string" && visitor.trim()) ip = visitor.trim();
  }
  // Some proxies append a port to IPv4 addresses. Do not truncate IPv6.
  ip = ip.replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, "$1");
  return ipKeyGenerator(ip);
}
