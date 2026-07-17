import { BlockList, isIP } from "net";

/**
 * Cloudflare's published egress ranges (https://www.cloudflare.com/ips/).
 * They change rarely; refresh from https://www.cloudflare.com/ips-v4 and
 * https://www.cloudflare.com/ips-v6 if Cloudflare announces new ranges.
 */
export const CLOUDFLARE_IP_RANGES: readonly string[] = [
  // IPv4
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  // IPv6
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

/**
 * Translate the TRUST_PROXY setting into a value for Express's
 * "trust proxy". Two forms are accepted:
 *
 * - a plain integer ("1", "2"): the legacy fixed hop count. Fragile: if the
 *   proxy chain gains or loses a hop (e.g. Cloudflare changes how it builds
 *   X-Forwarded-For), request.ip silently becomes a proxy address and the
 *   rate limiter starts keying every visitor on a handful of shared IPs.
 * - a comma-separated list of subnets: named subnets Express understands
 *   ("loopback", "linklocal", "uniquelocal"), literal IPs/CIDRs, and the
 *   keyword "cloudflare" which expands to CLOUDFLARE_IP_RANGES. Express then
 *   skips every trusted address in X-Forwarded-For regardless of how many
 *   entries the proxies add, so request.ip stays the real visitor.
 */
export function resolveTrustProxy(value: string): number | string[] {
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const subnets: string[] = [];
  for (const token of trimmed.split(",")) {
    const subnet = token.trim();
    if (!subnet) continue;
    if (subnet.toLowerCase() === "cloudflare") {
      subnets.push(...CLOUDFLARE_IP_RANGES);
    } else {
      subnets.push(subnet);
    }
  }
  return subnets;
}

const cloudflareBlockList = new BlockList();
for (const range of CLOUDFLARE_IP_RANGES) {
  const [address, prefix] = range.split("/");
  cloudflareBlockList.addSubnet(
    address,
    Number(prefix),
    isIP(address) === 6 ? "ipv6" : "ipv4"
  );
}

/**
 * Check whether an IP belongs to Cloudflare's published ranges. Used to
 * detect that client-IP resolution stopped short at a Cloudflare edge
 * address (i.e. X-Forwarded-For no longer contains the visitor).
 */
export function isCloudflareIP(ip: string): boolean {
  // Express may report IPv4 clients as IPv4-mapped IPv6 (::ffff:1.2.3.4);
  // compare them against the IPv4 ranges.
  const normalized = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  const family = isIP(normalized);
  if (family === 0) return false;
  return cloudflareBlockList.check(normalized, family === 6 ? "ipv6" : "ipv4");
}
