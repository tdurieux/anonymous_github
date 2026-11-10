# Production edge logging

Load `anonymous-logging.conf` in Nginx's **http** context, normally by installing it as `/etc/nginx/conf.d/anonymous-logging.conf`. Add this directive inside each application **server** block, including HTTP redirects and alternate hostnames:

```nginx
access_log /var/log/nginx/anonymous-access.log anonymous_json buffer=64k flush=1s;
```

Back up the existing configuration, run `sudo nginx -t`, then gracefully reload Nginx. On validation failure restore the backup before reloading. The server-level directive replaces the inherited combined access log for that virtual host; do not add a second combined log containing raw queries.

The JSON log separates visitor and Cloudflare edge addresses. Cloudflare headers are accepted only for peers in its published IP ranges. Direct requests cannot spoof the visitor IP or Ray ID through these headers. Refresh the ranges from the two URLs in the config when Cloudflare changes them. This configuration deliberately leaves `real_ip`, `X-Forwarded-For`, and application rate-limit identity unchanged.

Use `app_request_id` to correlate with API/streamer request logs and `cf_ray` with Cloudflare security events. `edge_request_id` exists even when the upstream never responds. Upstream statuses and connect/header/response timings separate origin failures from proxy failures. Status 499 and an empty `completion` identify incomplete requests; connection fields expose keep-alive reuse. Use the separate Nginx error log to distinguish connection-slot exhaustion from timeouts. An access event is emitted when its request finishes, so per-second counts are completion counts, not exact arrival rates.

Route labels omit queries, repository IDs and file paths. Cookies, authorization headers, bodies and referrers are not collected. User-agent text is JSON escaped. Treat IPs and Ray IDs as private operational data: keep logs readable only by operators. On Ubuntu, the existing `/var/log/nginx/*.log` logrotate rule covers this file; verify it creates mode 0640, compresses old logs and retains no more than 14 daily rotations. Watch disk usage during floods; daily rotation is not a hard size cap.

This is observability, not flood prevention. Cloudflare rate limiting/challenges and origin connection limits need a separate measured rollout. Do not block the Cloudflare edge IPs reported in `peer_ip` as if they were visitors.

Validate with the installed Nginx binary before rollout:

```sh
python3 scripts/test-nginx-logging.py deploy/nginx/anonymous-logging.conf
```

The test starts an isolated loopback listener and checks trusted IPv4/IPv6 peers, spoofed headers, missing-header fallback, JSON escaping and omitted sensitive data. It never changes production listeners.

## Bulk file/listing protection

Install `anonymous-bulk-limits.conf` in the http context, and create an empty root-owned `/etc/nginx/anonymous-bulk-blocks.map` with mode 0600. The latter can hold private temporary blocks in this format:

```nginx
"~^2026-11-10T.*:203\\.0\\.113\\.9$" 1;
```

Dates use the Nginx host timezone; production uses UTC. Such a block automatically ceases matching at midnight. Remove expired entries during maintenance. Use only verified visitor IPs, never Cloudflare edge IPs. Targeted blocks apply only to the file/listing paths and return a one-hour Retry-After; they do not block ZIPs or the whole site.

Install the location/server fragments under `/etc/nginx/snippets/`. Include `anonymous-bulk-location.conf` inside each application's proxied `location /`, and `anonymous-bulk-server.conf` in its enclosing HTTPS server. Run `nginx -t` before gracefully reloading. Keep a backup for rollback. Do not enable proxy_intercept_errors: application 429 responses should retain their existing bodies and headers.

Limits aggregate across repositories per trusted client IP. File reads allow a burst of 60 plus a sustained four requests/minute; listing/count/search reads allow a burst of 30 plus two/minute. GET and HEAD count, including conditional requests. Other paths have empty limit keys and do not consume these budgets. Shared-NAT users share these limits, so review legitimate 429 rates and adjust if needed. Neither User-Agent nor Referer grants a bypass. This protects these API routes, not the homepage or every source of resource exhaustion.

Rollback by removing the server/location includes, validating, and reloading; then remove the unused http config. Existing client identification and application rate limits are unchanged.

Run `python3 scripts/test-nginx-bulk-limits.py deploy/nginx` on a host with Nginx to test these limits against an isolated mock origin. It checks budgets, per-client separation, targeted blocks and ZIP/navigation/write exclusions without sending a traffic burst to production.
